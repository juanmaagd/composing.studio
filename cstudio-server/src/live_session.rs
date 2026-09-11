//! HTTP route that brokers a GPT-Live session using OpenAI's Responses
//! delegation, so the voice model can call `replace_score` to edit the
//! shared ABC document.
//!
//! The browser negotiates WebRTC locally and POSTs its SDP offer to this
//! route. The handler attaches the server-side `OPENAI_API_KEY`, the voice
//! and backend instructions, and the `replace_score` tool definition, then
//! forwards the request to OpenAI and relays the JSON response verbatim.

use serde::{Deserialize, Serialize};
use serde_json::json;
use warp::{filters::BoxedFilter, http::StatusCode, Filter, Rejection, Reply};

const OPENAI_LIVE_SESSIONS_URL: &str = "https://api.openai.com/v1/live/sessions";

const LIVE_INSTRUCTIONS: &str = "You are a co-producer in a live music session. Keep replies short and warm. When the user asks for anything musical -- create, change, transpose, add a voice, change tempo or mood -- delegate it to the backend immediately and say what you are doing in a few words while it works.";

const BACKEND_INSTRUCTIONS: &str = "## Voice conversation context
You are helping an assistant in a live voice conversation about music. Transcripts can contain mistakes, unfinished phrases, and later corrections. Use the latest context. If a needed detail is still unclear, ask for that detail instead of guessing.

## Task instructions
You are a session musician. Translate every request into valid ABC notation and call replace_score with the COMPLETE updated document, never a fragment.

ABC octave syntax -- get this exactly right:
  C D E F G A B  = the octave starting at middle C
  c d e f g a b  = one octave ABOVE that (lowercase)
  C, D, E,       = one octave BELOW (comma AFTER the letter)
  C,, D,,        = two octaves below
  c' d'          = two octaves above (apostrophe AFTER the letter)
A comma or apostrophe BEFORE a note letter is invalid ABC. Renderers silently ignore it, so the score looks unchanged and no error appears. To move music down an octave, append a comma to every note letter.

Multiple voices: always declare them as separate V: blocks --
  V:1
  <bars>
  V:2
  <bars>
Never use %%staves; it collapses both voices onto a single staff.

Instrument: an instrument named in words is only decoration on the page. To
change what the listener actually hears, put a %%MIDI program line in the
header. Values (abcjs uses zero-based General MIDI numbers):
  0 piano, 24 nylon guitar, 40 violin, 42 cello, 46 harp, 56 trumpet,
  68 oboe, 71 clarinet, 73 flute, 75 pan flute, 77 shakuhachi, 107 koto
A V: name= label is printed on the page and changes nothing that is heard.
Every voice meant to sound different needs its own %%MIDI program line as the
first line inside its own V: block. When you add a voice to an existing score,
carry the other voices' program lines across unchanged -- dropping one leaves
that voice on piano while its label still claims otherwise, and nothing warns
anybody. Omit the line only to leave an instrument as it already is.

## Never pass an invention off as the requested work
The worst answer you can give is your own composition under someone else's
title: the score looks plausible, nobody is told, and the substitution is
only discovered in front of an audience. Silence about it is the failure,
not the inability.

Sort every named work into one of three cases and act accordingly.
  1. You know the melody and it is public domain -- traditional songs, folk
     tunes, classical repertoire. Write it accurately.
  2. The work exists but is in copyright, or you are not confident of the
     actual notes. Say which of the two it is, out loud, and do NOT call
     replace_score. Offer to write an original piece in the same style, and
     wait for the user to agree before writing anything.
  3. The work does not exist. Say so.

Whenever you write an original piece, the T: line must name it as original
and your spoken reply must say it is not the requested work. Never reuse the
requested title for music you invented, and never leave the substitution
unmentioned.

## Return the result
Return what changed in one short sentence. Use the values you actually wrote. Do not invent a successful edit.";

/// Request body sent by the browser: the local WebRTC SDP offer.
#[derive(Debug, Deserialize)]
struct LiveSessionRequest {
    sdp: String,
}

/// Error body returned when the session cannot be created.
#[derive(Debug, Serialize)]
struct LiveSessionError {
    error: String,
}

/// The `replace_score` tool definition, in the flattened Responses API shape.
fn replace_score_tool() -> serde_json::Value {
    json!({
        "type": "function",
        "name": "replace_score",
        "description": "Replace the entire ABC notation score in the shared editor. Always send the complete document, never a fragment.",
        "parameters": {
            "type": "object",
            "properties": {
                "abc": { "type": "string", "description": "The complete ABC document." },
                "summary": { "type": "string", "description": "One short sentence on what changed." }
            },
            "required": ["abc", "summary"],
            "additionalProperties": false
        }
    })
}

/// Construct the `/live-session` route.
pub fn route() -> BoxedFilter<(impl Reply,)> {
    warp::path("live-session")
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and_then(handle_live_session)
        .boxed()
}

async fn handle_live_session(req: LiveSessionRequest) -> Result<impl Reply, Rejection> {
    log::info!("live-session: request received");
    let api_key = match std::env::var("OPENAI_API_KEY") {
        Ok(key) if !key.trim().is_empty() => key,
        _ => {
            return Ok(warp::reply::with_status(
                warp::reply::json(&LiveSessionError {
                    error: "OPENAI_API_KEY is not configured on the server".into(),
                }),
                StatusCode::SERVICE_UNAVAILABLE,
            ));
        }
    };

    let payload = json!({
        "session": {
            "model": "gpt-live-1",
            "instructions": LIVE_INSTRUCTIONS,
            "delegation": {
                "type": "responses",
                "responses": {
                    "model": "gpt-5.6-luna",
                    "instructions": BACKEND_INSTRUCTIONS,
                    "tools": [replace_score_tool()],
                    "tool_choice": "auto"
                }
            }
        },
        "transport": {
            "type": "webrtc",
            "sdp": req.sdp
        }
    });

    let client = reqwest::Client::new();
    let response = client
        .post(OPENAI_LIVE_SESSIONS_URL)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(err) => {
            return Ok(warp::reply::with_status(
                warp::reply::json(&LiveSessionError {
                    error: format!("Failed to reach OpenAI: {}", err),
                }),
                StatusCode::BAD_GATEWAY,
            ));
        }
    };

    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    match response.json::<serde_json::Value>().await {
        Ok(body) => Ok(warp::reply::with_status(warp::reply::json(&body), status)),
        Err(err) => Ok(warp::reply::with_status(
            warp::reply::json(&LiveSessionError {
                error: format!("Invalid response from OpenAI: {}", err),
            }),
            StatusCode::BAD_GATEWAY,
        )),
    }
}
