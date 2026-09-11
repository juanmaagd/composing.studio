// Edit benchmark: the demo does not write one score, it writes one and then
// edits it half a dozen times on stage. Each turn feeds the model the score it
// produced last turn, exactly as sendScoreContext does in the browser, so
// drift compounds here the same way it would in front of an audience.
//
// Per step it asks two questions:
//   did the requested change happen?
//   is the melody still the melody?
//
//   node spike/edit-bench.mjs
import { readFileSync } from "node:fs";

const KEY = readFileSync(new URL("../../openai.key", import.meta.url), "utf8").trim();
const MODEL = process.env.DELEGATE_MODEL ?? "gpt-5.6-luna";

const RS = readFileSync(
  new URL("../cstudio-server/src/live_session.rs", import.meta.url),
  "utf8"
);
const m = RS.match(/const BACKEND_INSTRUCTIONS: &str = "([\s\S]*?)";\n/);
if (!m) throw new Error("BACKEND_INSTRUCTIONS not found in live_session.rs");
const SYSTEM = m[1];

const TOOL = {
  type: "function",
  name: "replace_score",
  description: "Replace the entire ABC notation score in the shared editor.",
  parameters: {
    type: "object",
    properties: {
      abc: { type: "string", description: "The complete ABC document." },
      summary: { type: "string", description: "One short sentence on what changed." },
    },
    required: ["abc", "summary"],
    additionalProperties: false,
  },
};

// The melody the whole run has to survive: Ode to Joy.
const MELODY = "EEFGGFEDCCDE";

// Only the first voice carries the tune once accompaniment is added, so
// compare that and let the lower voice do whatever it likes.
function firstVoiceNotes(abc, count = 12) {
  const lines = abc.split("\n");
  const vIdx = lines.findIndex((l) => /^V:/.test(l.trim()));
  let body;
  if (vIdx >= 0) {
    const rest = lines.slice(vIdx + 1);
    const nextV = rest.findIndex((l) => /^V:/.test(l.trim()));
    // Directives and headers live inside V: blocks too, and "%%MIDI program"
    // is full of letters the note regex will happily read as D, G and A.
    body = (nextV >= 0 ? rest.slice(0, nextV) : rest)
      .filter((l) => !/^[A-Za-z]:/.test(l) && !l.trimStart().startsWith("%"))
      .join(" ");
  } else {
    body = lines.filter((l) => !/^[A-Za-z]:/.test(l) && !l.startsWith("%")).join(" ");
  }
  // Chords in brackets: keep only the top note so harmony does not read as melody.
  body = body.replace(/\[([^\]]*)\]/g, (_, inner) => (inner.match(/[_^=]*[A-Ga-g][,']*/g) ?? []).slice(-1)[0] ?? "");
  const notes = body.match(/[_^=]*[A-Ga-g][,']*/g) ?? [];
  return notes.slice(0, count).map((n) => n.replace(/[_^=,']/g, "").toUpperCase()).join("");
}

function intervals(letters) {
  const deg = (c) => "CDEFGAB".indexOf(c);
  const out = [];
  for (let i = 1; i < letters.length; i++) {
    let d = deg(letters[i]) - deg(letters[i - 1]);
    if (d > 3) d -= 7;
    if (d < -3) d += 7;
    out.push(d);
  }
  return out.join(",");
}

const WANT = intervals(MELODY);

// The demo arc: one famous melody, then edit it live.
const STEPS = [
  {
    say: "Escribí el Himno de la Alegría de Beethoven",
    want: "la melodía correcta",
    check: (abc) => (intervals(firstVoiceNotes(abc)) === WANT ? null : "melodía incorrecta de entrada"),
  },
  {
    say: "Cambiala para que suene con flauta",
    want: "%%MIDI program 73",
    check: (abc) => (/%%MIDI\s+program\s+73\b/.test(abc) ? null : "no puso program 73"),
  },
  {
    say: "Hacela más lenta",
    want: "Q: más bajo",
    check: (abc, prev) => {
      const q = (s) => Number((s.match(/^Q:.*?=\s*(\d+)/m) ?? [])[1] ?? NaN);
      const [a, b] = [q(prev), q(abc)];
      if (Number.isNaN(b)) return "no dejó línea Q:";
      if (Number.isNaN(a)) return null;
      return b < a ? null : `tempo no bajó (${a} -> ${b})`;
    },
  },
  {
    say: "Agregá una segunda voz de acompañamiento más grave",
    want: "V:1 y V:2",
    check: (abc) => {
      const vs = (abc.match(/^V:/gm) ?? []).length;
      if (vs < 2) return `solo ${vs} voz declarada`;
      if (/%%staves/.test(abc)) return "usó %%staves (colapsa los pentagramas)";
      return null;
    },
  },
  {
    say: "Que la flauta sea un violín",
    want: "%%MIDI program 40",
    check: (abc) => (/%%MIDI\s+program\s+40\b/.test(abc) ? null : "no cambió a program 40"),
  },
  {
    say: "Dejá el violín arriba pero que la voz grave sea un cello",
    want: "un program distinto por voz",
    check: (abc) => {
      const progs = [...abc.matchAll(/%%MIDI\s+program\s+(\d+)/g)].map((x) => x[1]);
      if (progs.length < 2) return `solo ${progs.length} directiva de instrumento`;
      if (new Set(progs).size < 2) return `ambas voces con el mismo instrumento (${progs.join()})`;
      return null;
    },
  },
];

async function turn(history) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: history, tools: [TOOL], tool_choice: "auto" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("HTTP " + res.status + " " + JSON.stringify(j).slice(0, 200));
  const call = (j.output ?? []).find((o) => o.type === "function_call");
  const said = (j.output ?? []).flatMap((o) => o.content ?? []).map((p) => p.text ?? "").join(" ").trim();
  return { abc: call ? JSON.parse(call.arguments).abc ?? "" : null, said };
}

const history = [{ role: "system", content: SYSTEM }];
let score = "";
let failures = 0;

console.log(`modelo: ${MODEL}   melodía base: ${MELODY}\n`);

for (const [i, step] of STEPS.entries()) {
  // The browser re-sends the current score before every instruction.
  if (score) history.push({ role: "user", content: `Partitura actual:\n${score}` });
  history.push({ role: "user", content: step.say });

  const t0 = Date.now();
  const { abc, said } = await turn(history);
  const ms = Date.now() - t0;

  console.log(`${i + 1}. "${step.say}"   (${ms}ms)`);
  if (!abc) {
    console.log(`   NO EDITO -- dijo: ${said.slice(0, 140).replace(/\s+/g, " ")}\n`);
    failures++;
    continue;
  }

  const prev = score;
  score = abc;
  history.push({ role: "assistant", content: `Escribí:\n${abc}` });

  const problem = step.check(abc, prev);
  const got = firstVoiceNotes(abc);
  const kept = intervals(got) === WANT;

  console.log(`   ${problem ? "FALLA  " : "ok     "} ${step.want}${problem ? ` -- ${problem}` : ""}`);
  console.log(`   ${kept ? "ok     " : "DERIVA "} melodía: ${got}${kept ? "" : `   (esperado ${MELODY})`}`);
  const prog = [...abc.matchAll(/%%MIDI\s+program\s+(\d+)/g)].map((x) => x[1]).join(",");
  const q = (abc.match(/^Q:.*$/m) ?? ["(sin Q:)"])[0];
  console.log(`   estado: voces=${(abc.match(/^V:/gm) ?? []).length}  program=${prog || "-"}  ${q}\n`);
  if (problem || !kept) failures++;
}

console.log(failures === 0 ? "TODA LA SECUENCIA OK" : `PASOS CON PROBLEMA: ${failures}/${STEPS.length}`);
console.log("\n--- partitura final ---\n" + score);
