import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Icon,
  Input,
  InputGroup,
  InputRightElement,
  Link,
  Stack,
  Switch,
  Text,
  useToast,
} from "@chakra-ui/react";
import {
  VscChevronRight,
  VscFolderOpened,
  VscGist,
  VscRepoPull,
} from "react-icons/vsc";
import { useDebounce } from "use-debounce";
import useStorage from "use-local-storage-state";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api";
import animals from "../lib/animals.json";
import Rustpad, { UserInfo } from "../lib/rustpad";
import LiveAgent, { LiveAgentState, LiveAgentActivity } from "../lib/liveAgent";
import VoiceDock from "../components/VoiceDock";
import ConnectionStatus from "../components/ConnectionStatus";
import Footer from "../components/Footer";
import User from "../components/User";
import Score from "../components/Score";
import fluteDuetAbc from "../music/fluteDuet.abc?raw";
import fugueAbc from "../music/fugue.abc?raw";
import bartokAbc from "../music/bartok.abc?raw";
import twinkleAbc from "../music/twinkle.abc?raw";
import Split from "react-split";
import "./Split.css";

function getWsUri(id: string) {
  return (
    (window.location.origin.startsWith("https") ? "wss://" : "ws://") +
    window.location.host +
    `/api/socket/${id}`
  );
}

function generateName() {
  return "Anonymous " + animals[Math.floor(Math.random() * animals.length)];
}

function generateHue() {
  return Math.floor(Math.random() * 360);
}

function EditorPage() {
  const toast = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const [name, setName] = useStorage("name", generateName);
  const [hue, setHue] = useStorage("hue", generateHue);
  const [editor, setEditor] = useState<editor.IStandaloneCodeEditor>();
  const [darkMode, setDarkMode] = useStorage("darkMode", () => false);
  const rustpad = useRef<Rustpad>();
  const { id } = useParams<string>();
  const [voiceState, setVoiceState] = useState<LiveAgentState>("idle");
  const [voiceActivity, setVoiceActivity] =
    useState<LiveAgentActivity>("listening");
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const liveAgent = useRef<LiveAgent>();
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (editor?.getModel()) {
      const model = editor.getModel()!;
      model.setValue("");
      model.setEOL(0); // LF
      rustpad.current = new Rustpad({
        uri: getWsUri(id!),
        editor,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => {
          setConnection("desynchronized");
          toast({
            title: "Desynchronized with server",
            description: "Please save your work and refresh the page.",
            status: "error",
            duration: null,
          });
        },
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [id, editor, toast, setUsers]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({ name, hue });
    }
  }, [connection, name, hue]);

  async function handleCopy() {
    await navigator.clipboard.writeText(`${window.location.origin}/${id}`);
    toast({
      title: "Copied!",
      description: "Link copied to clipboard",
      status: "success",
      duration: 2000,
      isClosable: true,
    });
  }

  function handleDarkMode() {
    setDarkMode(!darkMode);
  }

  function handleLoadSample() {
    const samples = [fluteDuetAbc, fugueAbc, bartokAbc, twinkleAbc];

    if (editor?.getModel()) {
      const model = editor.getModel()!;
      model.pushEditOperations(
        editor.getSelections(),
        [
          {
            range: model.getFullModelRange(),
            text: samples[Math.floor(Math.random() * samples.length)],
          },
        ],
        () => null
      );
      editor.setPosition({ column: 0, lineNumber: 0 });
    }
  }

  useEffect(() => {
    return () => {
      void liveAgent.current?.stop();
      liveAgent.current = undefined;
    };
  }, [editor, id]);

  async function handleToggleVoice() {
    if (!editor || !audioRef.current) return;

    if (voiceState === "live" || voiceState === "connecting") {
      await liveAgent.current?.stop();
      return;
    }

    setVoiceError("");
    if (!liveAgent.current) {
      liveAgent.current = new LiveAgent(editor, audioRef.current, {
        onStateChange: setVoiceState,
        onActivityChange: setVoiceActivity,
        onMutedChange: setVoiceMuted,
        onError: setVoiceError,
        onSummary: (summary) =>
          toast({
            title: "Co-producer",
            description: summary,
            status: "info",
            duration: 4000,
            isClosable: true,
          }),
      });
    }

    try {
      await liveAgent.current!.start();
    } catch {
      // Error state and toast are already reported via the callbacks above.
    }
  }

  const [text, setText] = useState("");
  const [abcString] = useDebounce(text, 100, { maxWait: 1000 });

  return (
    <Flex
      direction="column"
      h="100vh"
      overflow="hidden"
      bgColor={darkMode ? "#1e1e1e" : "white"}
      color={darkMode ? "#cbcaca" : "inherit"}
      className={darkMode ? "dark-mode" : undefined}
    >
      <Box
        flexShrink={0}
        bgColor={darkMode ? "#333333" : "#e8e8e8"}
        color={darkMode ? "#cccccc" : "#383838"}
        textAlign="center"
        fontSize="sm"
        py={0.5}
      >
        <Button
          display={{ base: "inline-flex", md: "none" }}
          size="xs"
          variant="ghost"
          aria-expanded={sidebarOpen}
          aria-controls="studio-sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          mr={2}
        >
          {sidebarOpen ? "Close settings" : "Studio settings"}
        </Button>
        Composing Studio
      </Box>
      <Flex flex="1 0" minH={0}>
        <Container
          w="xs"
          id="studio-sidebar"
          display={{ base: sidebarOpen ? "block" : "none", md: "block" }}
          position={{ base: "absolute", md: "static" }}
          top="32px"
          bottom="22px"
          zIndex={30}
          boxShadow={{ base: "0 8px 32px rgba(25, 16, 40, 0.2)", md: "none" }}
          flexShrink={0}
          bgColor={darkMode ? "#252526" : "#f3f3f3"}
          overflowY="auto"
          maxW="full"
          lineHeight={1.4}
          py={4}
        >
          <ConnectionStatus darkMode={darkMode} connection={connection} />

          <Flex justifyContent="space-between" mt={4} mb={1.5} w="full">
            <Heading size="sm">Dark Mode</Heading>
            <Switch isChecked={darkMode} onChange={handleDarkMode} />
          </Flex>

          <Heading mt={4} mb={1.5} size="sm">
            Share Link
          </Heading>
          <InputGroup size="sm">
            <Input
              readOnly
              pr="3.5rem"
              variant="outline"
              bgColor={darkMode ? "#3c3c3c" : "white"}
              borderColor={darkMode ? "#3c3c3c" : "white"}
              value={`${window.location.origin}/${id}`}
            />
            <InputRightElement width="3.5rem">
              <Button
                h="1.4rem"
                size="xs"
                onClick={handleCopy}
                _hover={{ bg: darkMode ? "#575759" : "gray.200" }}
                bgColor={darkMode ? "#575759" : "gray.200"}
              >
                Copy
              </Button>
            </InputRightElement>
          </InputGroup>

          <Heading mt={4} mb={1.5} size="sm">
            Active Users
          </Heading>
          <Stack spacing={0} mb={1.5} fontSize="sm">
            <User
              info={{ name, hue }}
              isMe
              onChangeName={(name) => name.length > 0 && setName(name)}
              onChangeColor={() => setHue(generateHue())}
              darkMode={darkMode}
            />
            {Object.entries(users).map(([id, info]) => (
              <User key={id} info={info} darkMode={darkMode} />
            ))}
          </Stack>

          <Heading mt={4} mb={1.5} size="sm">
            About
          </Heading>
          <Text fontSize="sm" mb={1.5}>
            <strong>Composing Studio</strong> is an open-source collaborative
            web application that lets people write and engrave music together
            using{" "}
            <Link
              color="blue.600"
              fontWeight="semibold"
              href="https://abcnotation.com/"
              isExternal
            >
              ABC notation
            </Link>
            .
          </Text>
          <Text fontSize="sm" mb={1.5}>
            Share a link to this studio with others, and they'll be able to edit
            from their browser while seeing your changes in real time.
          </Text>
          <Text fontSize="sm" mb={1.5}>
            Built using Rust and TypeScript. See the{" "}
            <Link
              color="blue.600"
              fontWeight="semibold"
              href="https://github.com/ekzhang/composing.studio"
              isExternal
            >
              GitHub repository
            </Link>{" "}
            for details.
          </Text>

          <Button
            size="sm"
            colorScheme={darkMode ? "whiteAlpha" : "blackAlpha"}
            borderColor={darkMode ? "purple.400" : "purple.600"}
            color={darkMode ? "purple.400" : "purple.600"}
            variant="outline"
            leftIcon={<VscRepoPull />}
            mt={1}
            onClick={handleLoadSample}
          >
            Load an example
          </Button>
        </Container>
        <Flex
          flex={1}
          minW={0}
          h="100%"
          direction="column"
          overflow="hidden"
          position="relative"
          pb={{ base: "180px", md: "130px" }}
        >
          <HStack
            h={6}
            spacing={1}
            color="#888888"
            fontWeight="medium"
            fontSize="13px"
            px={3.5}
            flexShrink={0}
          >
            <Icon as={VscFolderOpened} fontSize="md" color="blue.500" />
            <Text>documents</Text>
            <Icon as={VscChevronRight} fontSize="md" />
            <Icon as={VscGist} fontSize="md" color="purple.500" />
            <Text>{id}</Text>
          </HStack>
          <Box flex={1} minH={0} h="100%" overflow="hidden">
            <Split className="split" minSize={50}>
              <Box>
                <Editor
                  theme={darkMode ? "vs-dark" : "vs"}
                  language="abc"
                  options={{
                    automaticLayout: true,
                    fontSize: 13,
                    wordWrap: "on",
                  }}
                  onMount={(editor) => setEditor(editor)}
                  onChange={(text) => {
                    if (text !== undefined) {
                      setText(text);
                    }
                  }}
                />
              </Box>

              <Box overflowX="auto">
                <Score key={abcString} notes={abcString} darkMode={darkMode} />
              </Box>
            </Split>
          </Box>
          <VoiceDock
            state={voiceState}
            activity={voiceActivity}
            muted={voiceMuted}
            error={voiceError}
            ready={!!editor}
            darkMode={darkMode}
            onToggle={handleToggleVoice}
            onMute={() => liveAgent.current?.setMuted(!voiceMuted)}
          />
          <audio ref={audioRef} autoPlay hidden />
        </Flex>
      </Flex>
      <Footer />
    </Flex>
  );
}

export default EditorPage;
