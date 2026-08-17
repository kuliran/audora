import { api } from "@audora/backend/convex/_generated/api";
import type { Id } from "@audora/backend/convex/_generated/dataModel";
import { useUser } from "@clerk/react-router";
import { RealtimeClient } from "@speechmatics/real-time-client";
import { useAction, useMutation, useQuery } from "convex/react";
import { Clock, Laptop, Mic, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import BubbleField from "../BubbleField";
import CircleBlobs from "../CircleBlobs";
import WaitingView from "./WaitingView";

interface TranscriptWord {
  content: string;
  type: 'word' | 'punctuation';
  isEos?: boolean;
  speaker?: string;
}

interface WordTiming {
  word: string;
  startTime: number;
  endTime: number;
}

interface TranscriptTurn {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
  words?: WordTiming[];
}

interface CurrentViewProps {
  conversationId: string;
}

export default function CurrentView({ conversationId }: CurrentViewProps) {
  // const { userId } = useAuth();
  const { user } = useUser();

  // Get current user and conversation data
  const currentUser = useQuery(api.users.getCurrentUser);
  const conversation = useQuery(
    api.conversations.get,
    { id: conversationId as Id<"conversations"> }
  );

  // Get initiator and scanner user data
  const initiatorUser = useQuery(
    api.users.get,
    conversation ? { id: conversation.initiatorUserId } : "skip"
  );
  const scannerUser = useQuery(
    api.users.get,
    conversation?.scannerUserId ? { id: conversation.scannerUserId } : "skip"
  );
  const [duration, setDuration] = useState(0);
  const [startTime] = useState<number>(Date.now());
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcriptResult, setTranscriptResult] = useState<any>(null);
  const [autoStarted, setAutoStarted] = useState(false);
  const [realtimeTranscript, setRealtimeTranscript] = useState<string>("");
  const [currentSentence, setCurrentSentence] = useState<string>("");
  const [displayTranscriptTurns, setDisplayTranscriptTurns] = useState<TranscriptTurn[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const isUnmountingRef = useRef(false);
  const audioChunksRef = useRef<Blob[]>([]);
  const speechmaticsClientRef = useRef<RealtimeClient | null>(null);
  const fullTranscriptRef = useRef<string>("");
  const transcriptTurnsRef = useRef<TranscriptTurn[]>([]);
  const currentTurnRef = useRef<{ speaker: string; text: string; startTime: number } | null>(null);

  const generateUploadUrl = useMutation(api.conversations.generateUploadUrl);
  const saveAudioStorageId = useMutation(api.conversations.saveAudioStorageId);
  // @ts-ignore - API will be available after convex dev regenerates types
  const generateSpeechmaticsJWT = useAction(api.speechmatics?.generateJWT);
  // @ts-ignore - API will be available after convex dev regenerates types
  const processRealtimeTranscript = useAction(api.realtimeTranscription?.processRealtimeTranscript);
  // @ts-ignore - API will be available after convex dev regenerates types
  const batchTranscribe = useAction(api.speechmaticsBatch?.batchTranscribe);
  const forceCompleteConversation = useMutation(
    api.conversations.forceCompleteConversation
  );
  const isLocalSetup = import.meta.env.VITE_LOCAL_AUTH === "true";

  // Check if current user is the scanner (not the initiator)
  const isScanner = currentUser && conversation && currentUser._id === conversation.scannerUserId;
  const expectedSpeakerCount =
    conversation?.participantMode === "solo"
      ? 1
      : conversation?.participantMode === "anonymous"
        ? 6
        : 2;

  // Auto-start recording when component mounts (only for initiator)
  useEffect(() => {
    if (!isLocalSetup && !autoStarted && currentUser && conversation && !isScanner) {
      setAutoStarted(true);
      const timeout = setTimeout(() => {
        void startRecording();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [autoStarted, currentUser, conversation, isLocalSetup, isScanner]);

  useEffect(() => {
    isUnmountingRef.current = false;
    return () => {
      isUnmountingRef.current = true;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      try {
        speechmaticsClientRef.current?.stopRecognition();
      } catch {
        // The remote session may already be closed.
      }
    };
  }, []);

  // Timer for recording duration
  useEffect(() => {
    const interval = setInterval(() => {
      const newDuration = Math.floor((Date.now() - startTime) / 1000);
      setDuration(newDuration);
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  const startRecording = async () => {
    if (isLocalSetup) {
      toast.info("Use the Audora Mac app for on-device Parakeet recording.");
      return;
    }
    if (isStarting || isRecording) return;

    setIsStarting(true);
    try {
      // Initialize Speechmatics client
      const client = new RealtimeClient();
      speechmaticsClientRef.current = client;

      // Flag to control when to send audio (only after session is ready)
      let isSessionReady = false;

      // Persistent buffer for building sentences across multiple AddTranscript events
      let sentenceBuffer = "";
      let currentSpeaker: string | undefined;
      let sentenceStartTime: number | undefined;
      let sentenceEndTime: number | undefined;
      let wordBuffer: WordTiming[] = [];

      // Set up real-time transcript event listeners
      client.addEventListener("receiveMessage", ({ data }: any) => {
        if (data.message === "RecognitionStarted") {
          console.log("Speechmatics session started - ready to receive audio");
          isSessionReady = true;
        } else if (data.message === "AddTranscript") {
          console.log("AddTranscript event received:", JSON.stringify(data, null, 2));

          for (const result of data.results) {
            console.log("Processing result:", result);

            // Track speaker and timing
            if (result.start_time !== undefined) {
              sentenceStartTime = sentenceStartTime ?? result.start_time;
              sentenceEndTime = result.end_time;
            }

            // Speaker label from diarization (e.g., "S1", "S2")
            const speaker = result.alternatives?.[0]?.speaker || "Unknown";
            const content = result.alternatives?.[0]?.content || "";

            console.log(`Result type: ${result.type}, speaker: ${speaker}, content: "${content}"`);

            if (result.type === "word") {
              sentenceBuffer += " " + content;
              currentSpeaker = speaker;
              // Capture word-level timing
              if (result.start_time !== undefined && result.end_time !== undefined) {
                wordBuffer.push({
                  word: content,
                  startTime: result.start_time,
                  endTime: result.end_time,
                });
              }
            } else if (result.type === "punctuation") {
              sentenceBuffer += content;
            }

            // End of sentence
            if (result.is_eos) {
              const completeSentence = sentenceBuffer.trim();
              const speakerLabel = currentSpeaker || "Unknown";

              console.log(`Complete sentence: [${speakerLabel}] "${completeSentence}"`);
              console.log(`Words with timing: ${wordBuffer.length} words`);

              // Save turn with speaker label and word-level timing
              if (completeSentence && sentenceStartTime !== undefined && sentenceEndTime !== undefined) {
                // Check if we need to merge with previous turn (same speaker)
                const lastTurn = transcriptTurnsRef.current[transcriptTurnsRef.current.length - 1];
                if (lastTurn && lastTurn.speaker === speakerLabel && (sentenceStartTime - lastTurn.endTime) < 2) {
                  // Merge with previous turn if same speaker and < 2s gap
                  lastTurn.text += " " + completeSentence;
                  lastTurn.endTime = sentenceEndTime;
                  // Append words to existing turn
                  if (lastTurn.words) {
                    lastTurn.words.push(...wordBuffer);
                  } else {
                    lastTurn.words = [...wordBuffer];
                  }
                } else {
                  // Create new turn with word-level timing
                  transcriptTurnsRef.current.push({
                    speaker: speakerLabel,
                    text: completeSentence,
                    startTime: sentenceStartTime,
                    endTime: sentenceEndTime,
                    words: [...wordBuffer],
                  });
                }
              }

              fullTranscriptRef.current += (fullTranscriptRef.current ? " " : "") + completeSentence;
              setRealtimeTranscript(fullTranscriptRef.current);
              setCurrentSentence("");

              // Update display with new turns
              setDisplayTranscriptTurns([...transcriptTurnsRef.current]);

              // Reset buffers for next sentence
              sentenceBuffer = "";
              currentSpeaker = undefined;
              sentenceStartTime = undefined;
              sentenceEndTime = undefined;
              wordBuffer = [];
            }
          }

          // Update current sentence being spoken (in progress)
          if (sentenceBuffer.trim()) {
            const speakerLabel = currentSpeaker || "Unknown";
            setCurrentSentence(`[${speakerLabel}] ${sentenceBuffer.trim()}`);
          }
        } else if (data.message === "EndOfTranscript") {
          console.log("Speechmatics: End of transcript");
          console.log("Final structured transcript:", transcriptTurnsRef.current);
        } else if (data.message === "Error") {
          console.error("Speechmatics error:", data);
        }
      });

      // Get JWT from Convex
      console.log("Getting Speechmatics JWT...");
      const jwt = await generateSpeechmaticsJWT();
      console.log("✅ JWT received successfully");

      // Get microphone stream first
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Set up AudioContext to stream to Speechmatics
      // Use browser's native sample rate (typically 48kHz) - Speechmatics supports it
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      console.log(`AudioContext sample rate: ${audioContext.sampleRate}Hz`);

      // Process audio - but only send when session is ready
      processor.onaudioprocess = (e) => {
        if (!isSessionReady) return; // Don't send until Speechmatics is ready

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32Array to Int16Array for Speechmatics
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }
        client.sendAudio(pcmData.buffer);
      };

      // Start Speechmatics session (will trigger RecognitionStarted event)
      console.log("Starting Speechmatics session...");
      try {
        await client.start(jwt, {
        transcription_config: {
          language: "en",
          operating_point: "enhanced",
          max_delay: 3.0,
          enable_partials: false,
          // conversation_config: {
          //   end_of_utterance_silence_trigger: 0.5,
          // },
          diarization: "speaker", // Enable speaker diarization
          speaker_diarization_config: {
            max_speakers: expectedSpeakerCount,
          },
          transcript_filtering_config: {
            // remove_disfluencies: true,
          },
        },
        audio_format: {
          type: "raw",
          encoding: "pcm_s16le",
          sample_rate: audioContext.sampleRate,
        },
      });
      console.log("✅ Speechmatics session started successfully");
      } catch (speechmaticsError) {
        console.error("❌ Failed to start Speechmatics session:", speechmaticsError);
        throw speechmaticsError;
      }

      // Create MediaRecorder for audio archival
      // Use a format supported by Speechmatics Batch API (mp4, mpeg, ogg, or webm as fallback)
      let mimeType = "audio/webm"; // fallback
      if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4";
      } else if (MediaRecorder.isTypeSupported("audio/mpeg")) {
        mimeType = "audio/mpeg";
      } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
        mimeType = "audio/ogg";
      }

      console.log("Using MediaRecorder with mimeType:", mimeType);

      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType,
      });
      setMediaRecorder(recorder);
      mediaRecorderRef.current = recorder;

      // Clear previous audio chunks and transcript data
      audioChunksRef.current = [];
      fullTranscriptRef.current = "";
      transcriptTurnsRef.current = [];
      setRealtimeTranscript("");
      setCurrentSentence("");
      setDisplayTranscriptTurns([]);

      // Collect audio chunks for storage
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle recording stop
      recorder.onstop = async () => {
        // Stop audio processing
        processor.disconnect();
        source.disconnect();
        audioContext.close();

        // Stop Speechmatics
        if (speechmaticsClientRef.current) {
          speechmaticsClientRef.current.stopRecognition();
        }

        // Clean up microphone
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setIsRecording(false);

        if (isUnmountingRef.current) return;

        // Process and save to Convex
        setIsProcessing(true);
        try {
          // Create audio blob from collected chunks
          const audioBlob = new Blob(audioChunksRef.current, {
            type: mimeType,
          });

          // Upload audio to Convex storage
          const uploadUrl = await generateUploadUrl();
          const uploadResult = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": audioBlob.type },
            body: audioBlob,
          });
          const { storageId } = await uploadResult.json();

          // Save storage ID
          await saveAudioStorageId({
            conversationId: conversationId as Id<"conversations">,
            storageId,
          });

          // Use the structured transcript from Speechmatics with speaker labels
          const structuredTranscript = transcriptTurnsRef.current;
          console.log("Final structured transcript with speakers:", structuredTranscript);

          if (structuredTranscript.length === 0) {
            console.error("❌ No transcript data was collected during recording");
            console.log("This usually means:");
            console.log("1. Speechmatics session didn't start properly");
            console.log("2. No audio was detected/spoken");
            console.log("3. Microphone permissions issue");
            toast.error("No transcript data collected. Check console for details.");
            return;
          }
          // Now run batch transcription for more accurate final transcript
          // console.log("Starting batch transcription for final accuracy...");
          try {
            // const batchResult = await batchTranscribe({
            //   storageId,
            //   conversationId: conversationId as Id<"conversations">,
            //   initiatorUserName: initiatorUser?.name || "S1",
            //   scannerUserName: scannerUser?.name || "S2",
            // });

            // console.log("Batch transcription complete:", batchResult);

            // Process batch transcript with speaker names
            const batchTranscriptWithNames = await processRealtimeTranscript({
              conversationId: conversationId as Id<"conversations">,
              transcriptTurns: structuredTranscript,
              initiatorName: initiatorUser?.name || "Speaker 1",
              scannerName: scannerUser?.name || "Speaker 2",
              userEmail: user?.primaryEmailAddress?.emailAddress,
              userName: user?.fullName || user?.firstName || undefined,
            });

            console.log("Final realtime transcript with names:", batchTranscriptWithNames);
            // Update UI with the more accurate batch result
            setTranscriptResult(batchTranscriptWithNames);
          } catch (batchError) {
            console.error("Batch transcription failed:", batchError);
            // Continue with real-time result if batch fails
          }
        } catch (error) {
          console.error("Error processing transcript:", error);
          toast.error("Error processing recording. Please try again.");
        } finally {
          try {
            await forceCompleteConversation({
              conversationId: conversationId as Id<"conversations">,
            });
          } catch (error) {
            console.error("Failed to finalize conversation status:", error);
          }
          setIsProcessing(false);
        }
      };

      // Start recording
      recorder.start(1000); // Collect chunks every second
      setIsRecording(true);
    } catch (error) {
      console.error("Error starting recording:", error);
      toast.error("Unable to start recording. Please check permissions and try again.");
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    } finally {
      setIsStarting(false);
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current ?? mediaRecorder;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const handleRecordClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // If loading user or conversation data
  if (!currentUser || !conversation) {
    return (
      <div className="w-full max-w-md flex items-center justify-center py-12">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-300">Loading...</p>
        </div>
      </div>
    );
  }

  // If user is the scanner, show waiting view
  if (isScanner) {
    return <WaitingView conversationId={conversationId} />;
  }

  if (isLocalSetup) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Laptop className="size-6" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Record in the Audora Mac app</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Browser recording uses Speechmatics and is disabled in this local setup. The Mac app
            records and transcribes on-device with Parakeet, then saves the result to this local
            Convex backend.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Use End or Delete above to clear this browser-created live conversation.
        </p>
      </div>
    );
  }

  console.log("realtimeTranscript", realtimeTranscript);
  console.log("currentSentence", currentSentence);

  // Otherwise, show recording UI for the initiator
  return (
    <div className="w-full max-w-md mx-auto space-y-8">
      {/* Main Content - Circle Section */}
      <div className="flex items-center justify-center px-6">
        <BubbleField isRecording={isRecording} />

        <div className="flex flex-col items-center">
          {/* Record Circle */}
          <div className="relative w-32 h-32 mb-6 flex items-center justify-center">
            {/* Aura / glow */}
            {isRecording && (
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  boxShadow: "0 0 30px 15px rgba(129, 140, 248, 0.5)",
                  animation: "pulseAura 1.5s infinite alternate",
                }}
              />
            )}

            {/* Actual button */}
            <button
              onClick={handleRecordClick}
              disabled={isProcessing || isStarting}
              className={`relative w-32 h-32 rounded-full flex items-center justify-center transition-all cursor-pointer
                ${isRecording ? "bg-primary/20 dark:bg-primary/30" : "bg-muted dark:bg-card"}
                ${isProcessing || isStarting ? "opacity-50 cursor-not-allowed" : "hover:bg-primary/30 dark:hover:bg-primary/40"}`}>
              {isProcessing || isStarting ? (
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              ) : isRecording ? (
                <div className="">
                  <CircleBlobs isRecording={true} onClick={handleRecordClick} />
                </div>
              ) : (
                <Mic className="w-8 h-8 text-primary" />
              )}
            </button>
          </div>

          {/* Add this CSS in your global stylesheet or tailwind config */}
          <style>{`
            @keyframes pulseAura {
              0% {
                box-shadow: 0 0 5px 5px rgba(129, 140, 248, 0.4);
              }
              100% {
                box-shadow: 0 0 15px 10px rgba(129, 140, 248, 0.6);
              }
            }
          `}</style>

          {/* Status text */}
          <div className="text-center mb-6">
            <p
              className="text-muted-foreground text-lg"
              style={{ fontFamily: "Simonetta, serif" }}>
              {isProcessing
                ? "Processing..."
                : isStarting
                ? "Starting..."
                : isRecording
                ? "Recording..."
                : "Tap to record..."}
            </p>
          </div>
        </div>
      </div>

      {/* Real-time Transcript Display */}
      {isRecording && (displayTranscriptTurns.length > 0 || currentSentence) && (
        <div className="bg-card border border-border rounded-2xl p-6 w-full shadow-lg">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Live Transcript</h3>
          <div className="space-y-4 max-h-64 overflow-y-auto">
            {displayTranscriptTurns.map((turn, index) => (
              <div key={index} className="flex space-x-3">
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-r from-primary to-accent flex items-center justify-center text-xs font-medium text-primary-foreground">
                    {turn.speaker.charAt(0)}
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center space-x-2 mb-1">
                    <span className="text-sm font-medium text-foreground">
                      {turn.speaker}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-sm leading-relaxed">{turn.text}</p>
                </div>
              </div>
            ))}
            {currentSentence && (
              <div className="flex space-x-3">
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-r from-green-500 to-teal-500 dark:from-green-400 dark:to-teal-400 flex items-center justify-center text-xs font-medium text-white animate-pulse">
                    {currentSentence.match(/\[(.+?)\]/)?.[1]?.charAt(0) || "?"}
                  </div>
                </div>
                <div className="flex-1">
                  <p className="text-primary text-sm italic">{currentSentence}...</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recording Stats */}
      <div className="bg-card border border-border rounded-2xl p-4 w-full space-y-3 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Duration</span>
          </div>
          <span className="text-sm font-medium text-foreground">
            {formatDuration(duration)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Participants</span>
          </div>
          <span className="text-sm text-foreground">
            {conversation.participantMode === "solo"
              ? "1 active"
              : conversation.scannerUserId
                ? "2 active"
                : "Anonymous speakers"}
          </span>
        </div>
      </div>

      {/* Transcript Results */}
      {transcriptResult && (
        <div className="bg-[#353E41] rounded-2xl p-4 space-y-4">
          <h3 className="text-lg font-medium">Recording Complete!</h3>
          <div className="space-y-2">
            <p className="text-sm text-gray-300">
              {transcriptResult.transcript?.length || 0} conversation turns
              processed
            </p>
            {transcriptResult.summary && (
              <p className="text-xs text-gray-400">{transcriptResult.summary}</p>
            )}
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="text-center space-y-2">
        <p className="text-sm text-gray-400">
          Continue your conversation naturally
        </p>
        <p className="text-xs text-gray-500">
          Tap the button to stop recording when finished
        </p>
      </div>
    </div>
  );
}
