import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Icon,
  IconButton,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { FiMic, FiMicOff, FiSquare, FiVolume2 } from "react-icons/fi";
import { LiveAgentActivity, LiveAgentState } from "../lib/liveAgent";

interface VoiceDockProps {
  state: LiveAgentState;
  activity: LiveAgentActivity;
  muted: boolean;
  error: string;
  ready: boolean;
  darkMode: boolean;
  onToggle: () => void;
  onMute: () => void;
}

export default function VoiceDock({
  state,
  activity,
  muted,
  error,
  ready,
  darkMode,
  onToggle,
  onMute,
}: VoiceDockProps) {
  const [elapsed, setElapsed] = useState(0);
  const busy =
    state === "connecting" ||
    state === "closing" ||
    (state === "live" && (activity === "thinking" || activity === "working"));
  useEffect(() => {
    setElapsed(0);
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    return () => clearInterval(timer);
  }, [busy, state, activity]);
  const status =
    state === "idle"
      ? "Offline"
      : state === "connecting"
      ? "Connecting"
      : state === "closing"
      ? "Ending"
      : state === "error"
      ? "Connection interrupted"
      : activity === "thinking"
      ? "Thinking"
      : activity === "working"
      ? "Updating score"
      : activity === "responding"
      ? "Responding"
      : muted
      ? "Microphone muted"
      : "Listening";
  const active = state === "live" || state === "connecting";
  return (
    <Box
      as="section"
      aria-label="Voice co-producer controls"
      position="absolute"
      bottom="12px"
      left={{ base: "12px", md: "50%" }}
      transform={{ base: "none", md: "translateX(-50%)" }}
      width={{ base: "calc(100% - 24px)", md: "470px" }}
      maxW="calc(100% - 24px)"
      zIndex={20}
      borderRadius="16px"
      bg={darkMode ? "#29282d" : "white"}
      color={darkMode ? "#f4f0fa" : "#292333"}
      boxShadow="0 8px 32px rgba(25, 16, 40, 0.2)"
      p={3}
    >
      <Flex align="center" gridGap={3} flexWrap="wrap">
        <Flex
          align="center"
          justify="center"
          w="40px"
          h="40px"
          borderRadius="12px"
          flexShrink={0}
          bg={darkMode ? "#453257" : "#f0e8fa"}
          color={darkMode ? "#dcc2ff" : "#6b36a0"}
        >
          {busy ? (
            <Spinner
              size="sm"
              aria-hidden="true"
              sx={{
                "@media (prefers-reduced-motion: reduce)": {
                  animation: "none",
                },
              }}
            />
          ) : (
            <Icon
              as={
                activity === "responding" && state === "live"
                  ? FiVolume2
                  : muted
                  ? FiMicOff
                  : FiMic
              }
              boxSize={5}
            />
          )}
        </Flex>
        <Box
          flex="1"
          minW="140px"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Text fontSize="sm" fontWeight="semibold">
            Voice Co-Producer
          </Text>
          <Text
            fontSize="xs"
            color={
              state === "error"
                ? darkMode
                  ? "#ffb4b4"
                  : "#a32121"
                : darkMode
                ? "#cbc0d6"
                : "#65566f"
            }
          >
            {status}
            {muted && state === "live" && activity !== "listening"
              ? " · Mic muted"
              : ""}
          </Text>
        </Box>
        <Flex gridGap={2} marginLeft="auto">
          {state === "live" && (
            <IconButton
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              title={
                muted
                  ? "Unmute microphone"
                  : "Mute microphone (you can still hear replies)"
              }
              aria-pressed={muted}
              icon={muted ? <FiMicOff /> : <FiMic />}
              onClick={onMute}
              variant="outline"
              minW="44px"
              h="44px"
              borderColor={darkMode ? "#756582" : "#bdb1c9"}
              bg={muted ? (darkMode ? "#543541" : "#fbe8ec") : "transparent"}
              _hover={{ bg: darkMode ? "#45364f" : "#f0e8fa" }}
            />
          )}
          <Button
            onClick={onToggle}
            isDisabled={!ready || state === "closing"}
            leftIcon={active ? <FiSquare /> : <FiMic />}
            colorScheme="purple"
            h="44px"
            fontSize="sm"
            px={4}
          >
            {state === "connecting"
              ? "Cancel"
              : state === "live"
              ? "End voice"
              : state === "error"
              ? "Retry voice"
              : state === "closing"
              ? "Ending"
              : "Start voice"}
          </Button>
        </Flex>
      </Flex>
      {(state === "idle" ||
        state === "connecting" ||
        state === "error" ||
        elapsed >= 20) && (
        <Text
          fontSize="xs"
          mt={2}
          lineHeight="1.5"
          color={darkMode ? "#cbc0d6" : "#65566f"}
          role={state === "error" ? "alert" : undefined}
        >
          {state === "error"
            ? error || "Voice disconnected. Retry to reconnect."
            : elapsed >= 20
            ? `Taking longer than usual (${elapsed}s). You can end voice and retry.`
            : state === "connecting"
            ? "Allow microphone access in your browser. You can cancel anytime."
            : ready
            ? "Talk through an idea. Your co-producer edits the shared score."
            : "Preparing the editor…"}
        </Text>
      )}
    </Box>
  );
}
