import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
    CheckCircle2,
    ChevronRight,
    CircleDashed,
    Clock,
    FileText,
    SkipForward,
    AlertTriangle,
    Sparkles,
} from "lucide-react";
import {
    deleteCvrDenoiseOutput,
    fetchCaseByNumber,
    runCvrChannelSeparation,
    runCvrDenoise,
    runCvrEventDetection,
    runCvrEmotionAnalysis,
    runCvrRoleIdentification,
    runCvrTranscription,
    updateCvrPipeline,
} from "../api/cases";
import { createDownloadTarget } from "../api/storage";
import useRecentCases from "../hooks/useRecentCases";
import { buildCasePreview } from "../utils/caseDisplay";
import { evaluateModuleReadiness } from "../utils/analysisAvailability";
import CvrCaseDetailsStep from "../components/CvrCaseDetailsStep";
import CvrUploadStep from "../components/CvrUploadStep";
import CvrReviewStep from "../components/CvrReviewStep";
import CvrPhaseStepper from "../components/CvrPhaseStepper";



const analysisStages = [
    {
        key: "denoise",
        label: "Audio Processing",
        description: "Reducing background noise and separating channels while preserving speech.",
        optional: true,
    },
    {
        key: "channels",
        label: "Channel Separation",
        description: "Isolate each speaker's audio using diarization.",
        optional: true,
    },
    {
        key: "transcription",
        label: "Transcription",
        description: "Generate time-coded transcripts with optional diarization.",
        optional: false,
    },
    {
        key: "events",
        label: "Key Event Identification",
        description: "Detect alarms, impacts, and tonal anomalies in the original audio.",
        optional: true,
    },
    {
        key: "roles",
        label: "Role Identification",
        description: "Map speaker labels to cockpit roles using role identification.",
        optional: true,
        group: "analysis",
    },
    {
        key: "emotion",
        label: "Emotion Recognition",
        description: "Estimate the dominant cockpit emotion from the CVR audio.",
        optional: true,
        group: "analysis",
    },
];


const StepBadge = ({ status }) => {
    if (status === "complete") {
        return (
            <span className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                <CheckCircle2 className="w-6 h-6" />
            </span>
        );
    }

    if (status === "skipped") {
        return (
            <span className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                <SkipForward className="w-6 h-6" />
            </span>
        );
    }

    if (status === "error") {
        return (
            <span className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center text-rose-600">
                <AlertTriangle className="w-6 h-6" />
            </span>
        );
    }

    if (status === "current") {
        return (
            <span className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white">
                <Clock className="w-5 h-5" />
            </span>
        );
    }

    return (
        <span className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
            <CircleDashed className="w-5 h-5" />
        </span>
    );
};

const ProgressStep = ({ label, description, status, isActive, onClick }) => {
    const Wrapper = onClick ? "button" : "div";
    return (
        <Wrapper
            type={onClick ? "button" : undefined}
            onClick={onClick}
            className={`flex flex-col items-center text-center flex-1 ${onClick ? "cursor-pointer" : ""}`}
        >
            <StepBadge status={status} />
            <p className={`mt-3 text-sm font-semibold ${isActive ? "text-emerald-700" : "text-gray-800"}`}>
                {label}
            </p>
            <p className={`mt-1 text-xs max-w-[160px] ${isActive ? "text-emerald-600" : "text-gray-500"}`}>
                {description}
            </p>
            {isActive && status !== "current" && status !== "error" && (
                <span className="mt-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    Reviewing
                </span>
            )}
        </Wrapper>
    );
};

const TabButton = ({ isActive, onClick, children, disabled = false }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`px-5 py-2 rounded-full text-sm font-medium transition-colors border disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200 disabled:hover:text-gray-300 ${isActive
            ? "bg-emerald-50 border-emerald-500 text-emerald-600"
            : "border-gray-200 text-gray-500 hover:text-emerald-600"
            }`}
    >
        {children}
    </button>
);

export default function CVR({ caseNumber: propCaseNumber }) {
    const { caseNumber: routeCaseNumber } = useParams();
    const caseNumber = propCaseNumber || routeCaseNumber;
    const navigate = useNavigate();
    const location = useLocation();
    const viaCaseDetailsFlowRef = useRef(Boolean(location.state?.viaCaseDetailsFlow));
    const [selectedCase, setSelectedCase] = useState(null);
    const [selectedCaseData, setSelectedCaseData] = useState(null);
    const isLinkedRoute = Boolean(caseNumber);
    const [workflowStage, setWorkflowStage] = useState(
        isLinkedRoute ? "analysis" : "caseDetails"
    );
    const [showResults, setShowResults] = useState(false);
    const [activeTab, setActiveTab] = useState("denoise");
    const [denoiseMethod, setDenoiseMethod] = useState("facebook_denoiser");
    const [denoisedAudioUrl, setDenoisedAudioUrl] = useState("");
    const [originalAudioUrl, setOriginalAudioUrl] = useState("");
    const [selectedCvrSourceKey, setSelectedCvrSourceKey] = useState("auto");
    const [eventDetectionSourceKey, setEventDetectionSourceKey] = useState("auto");
    const [channelSeparationSourceKey, setChannelSeparationSourceKey] = useState("auto");
    const [transcriptionCvrSourceKey, setTranscriptionCvrSourceKey] = useState("auto");
    const [transcriptionModel, setTranscriptionModel] = useState("openai/whisper-large-v3");
    const [transcriptionSource, setTranscriptionSource] = useState("auto");
    const [enableDiarization, setEnableDiarization] = useState(false);
    const [eventDetectionConfig, setEventDetectionConfig] = useState({
        threshold: 0.3,
        methods: ["spectral", "energy", "frequency"],
    });
    const [eventAudioUrls, setEventAudioUrls] = useState({});
    const [pipelineState, setPipelineState] = useState(null);
    const [transcriptionBlocker, setTranscriptionBlocker] = useState("");
    const [transcriptionBlockerTitle, setTranscriptionBlockerTitle] = useState("Transcription required");
    const [transcriptionSkipPrompt, setTranscriptionSkipPrompt] = useState(false);
    const [denoiseSkipNotice, setDenoiseSkipNotice] = useState("");
    const [denoiseHistoryNotice, setDenoiseHistoryNotice] = useState("");
    const [deleteDenoiseTarget, setDeleteDenoiseTarget] = useState(null);
    const [missingCvrChannelPrompt, setMissingCvrChannelPrompt] = useState(null);
    const [showCaseMenu, setShowCaseMenu] = useState(false);
    const caseMenuRef = useRef(null);
    const pipelineInitializedRef = useRef(false);
    const { recentCases } = useRecentCases(3);
    const cvrReadyCases = useMemo(() => {
        const list = recentCases.filter((item) => evaluateModuleReadiness(item, "cvr").ready);
        return list;
    }, [recentCases]);
    const [linkError, setLinkError] = useState("");
    const [missingDataTypes, setMissingDataTypes] = useState([]);
    const lastLinkedCaseRef = useRef(null);
    const resolvedCaseNumber = caseNumber || selectedCase?.id || null;
    const pipelineStorageKey = useMemo(
        () => (resolvedCaseNumber ? `cvrPipeline:${resolvedCaseNumber}` : null),
        [resolvedCaseNumber],
    );
    const cvrAttachments = useMemo(() => {
        if (!selectedCaseData || !Array.isArray(selectedCaseData.attachments)) {
            return [];
        }

        return selectedCaseData.attachments.filter((item) => {
            const type = String(item?.type || "").toUpperCase();
            const status = String(item?.status || "").toLowerCase();
            const name = String(item?.name || "").toLowerCase();
            return (
                type === "CVR" &&
                item?.storage?.objectKey &&
                status !== "pending" &&
                !name.includes("pending upload")
            );
        });
    }, [selectedCaseData]);
    const cvrChannelOptions = useMemo(
        () => [
            { id: "general", label: "Audio mix (full)" },
            { id: "channel-1", label: "Channel 1 – Captain" },
            { id: "channel-2", label: "Channel 2 – First Officer" },
            { id: "channel-3", label: "Channel 3 – Observer / area" },
            { id: "channel-4", label: "Channel 4 – Cockpit area mic (CAM)" },
        ],
        [],
    );
    const cvrAttachmentsByChannel = useMemo(() => {
        const map = new Map();
        cvrAttachments.forEach((attachment) => {
            const channelId = attachment?.channel || attachment?.channelId || "general";
            if (!map.has(channelId)) {
                map.set(channelId, attachment);
            }
        });
        return map;
    }, [cvrAttachments]);
    const cvrSourceOptions = useMemo(() => {
        const options = [{ value: "auto", label: "Auto (prefer audio mix)" }];
        cvrChannelOptions.forEach((channel) => {
            const attachment = cvrAttachmentsByChannel.get(channel.id);
            if (attachment) {
                options.push({
                    value: attachment.storage?.objectKey,
                    label: channel.label,
                });
            } else {
                options.push({
                    value: `missing:${channel.id}`,
                    label: `${channel.label} (missing)`,
                });
            }
        });

        const unknown = cvrAttachments.filter((attachment) => {
            const channelId = attachment?.channel || attachment?.channelId || "general";
            return !cvrChannelOptions.some((channel) => channel.id === channelId);
        });
        unknown.forEach((attachment) => {
            options.push({
                value: attachment.storage?.objectKey,
                label: attachment?.name || "Additional CVR audio",
            });
        });

        return options;
    }, [cvrAttachments, cvrAttachmentsByChannel, cvrChannelOptions]);

    useEffect(() => {
        if (selectedCvrSourceKey === "auto") {
            return;
        }
        const exists = cvrAttachments.some(
            (attachment) => attachment?.storage?.objectKey === selectedCvrSourceKey,
        );
        if (!exists) {
            setSelectedCvrSourceKey("auto");
        }
    }, [cvrAttachments, selectedCvrSourceKey]);
    useEffect(() => {
        if (eventDetectionSourceKey === "auto") {
            return;
        }
        const exists = cvrAttachments.some(
            (attachment) => attachment?.storage?.objectKey === eventDetectionSourceKey,
        );
        if (!exists) {
            setEventDetectionSourceKey("auto");
        }
    }, [cvrAttachments, eventDetectionSourceKey]);
    useEffect(() => {
        if (transcriptionCvrSourceKey === "auto") {
            return;
        }
        const exists = cvrAttachments.some(
            (attachment) => attachment?.storage?.objectKey === transcriptionCvrSourceKey,
        );
        if (!exists) {
            setTranscriptionCvrSourceKey("auto");
        }
    }, [cvrAttachments, transcriptionCvrSourceKey]);
    const handleCvrSourceChange = (event) => {
        const value = event.target.value;
        if (value.startsWith("missing:")) {
            const channelId = value.replace("missing:", "");
            const channel = cvrChannelOptions.find((entry) => entry.id === channelId);
            setMissingCvrChannelPrompt({
                channelId,
                label: channel?.label || "This channel",
            });
            return;
        }
        setSelectedCvrSourceKey(value);
    };
    const handleEventSourceChange = (event) => {
        const value = event.target.value;
        if (value.startsWith("missing:")) {
            const channelId = value.replace("missing:", "");
            const channel = cvrChannelOptions.find((entry) => entry.id === channelId);
            setMissingCvrChannelPrompt({
                channelId,
                label: channel?.label || "This channel",
            });
            return;
        }
        setEventDetectionSourceKey(value);
    };
    const handleTranscriptionSourceKeyChange = (event) => {
        const value = event.target.value;
        if (value.startsWith("missing:")) {
            const channelId = value.replace("missing:", "");
            const channel = cvrChannelOptions.find((entry) => entry.id === channelId);
            setMissingCvrChannelPrompt({
                channelId,
                label: channel?.label || "This channel",
            });
            return;
        }
        setTranscriptionCvrSourceKey(value);
    };
    const selectedCvrAttachment = useMemo(() => {
        if (selectedCvrSourceKey !== "auto") {
            const explicit = cvrAttachments.find(
                (item) => item?.storage?.objectKey === selectedCvrSourceKey,
            );
            if (explicit) {
                return explicit;
            }
        }

        const channelPriority = ["general", "channel-1", "channel-2", "channel-3", "channel-4"];
        for (let i = 0; i < channelPriority.length; i += 1) {
            const channelId = channelPriority[i];
            const match = cvrAttachments.find((item) => {
                const itemChannel = item?.channel || item?.channelId || "general";
                return itemChannel === channelId;
            });
            if (match) {
                return match;
            }
        }

        return cvrAttachments[0] || null;
    }, [cvrAttachments, selectedCvrSourceKey]);

    const clearStaleAudioErrors = useCallback((pipeline) => {
        if (!pipeline) {
            return pipeline;
        }

        const isAudioMissingError = (message) =>
            /audio (file )?not found|re-upload|not available for this case/i.test(message || "");

        let changed = false;
        const nextSteps = { ...pipeline.steps };
        Object.keys(nextSteps).forEach((key) => {
            const step = nextSteps[key];
            if (step?.status === "error" && isAudioMissingError(step.error)) {
                nextSteps[key] = { ...step, status: "pending", error: "" };
                changed = true;
            }
        });

        let nextEventDetection = pipeline.eventDetection;
        if (pipeline.eventDetection?.status === "error" && isAudioMissingError(pipeline.eventDetection.error)) {
            nextEventDetection = { status: "idle", events: [], error: "" };
            changed = true;
        }

        if (!changed) {
            return pipeline;
        }

        return { ...pipeline, steps: nextSteps, eventDetection: nextEventDetection };
    }, []);

    const buildInitialPipeline = useCallback(() => ({
        version: 1,
        current: analysisStages[0]?.key || "denoise",
        steps: analysisStages.reduce((acc, step) => {
            acc[step.key] = { status: "pending", updatedAt: new Date().toISOString() };
            return acc;
        }, {}),
    }), []);

    const updatePipelineState = useCallback((updater) => {
        setPipelineState((prev) => {
            const base = prev || buildInitialPipeline();
            return typeof updater === "function" ? updater(base) : updater;
        });
    }, [buildInitialPipeline]);

    useEffect(() => {
        if (!caseNumber) {
            lastLinkedCaseRef.current = null;
            setMissingDataTypes([]);
            setSelectedCase(null);
            setSelectedCaseData(null);
            setWorkflowStage("caseDetails");
            setShowResults(false);
            setActiveTab("denoise");
            setPipelineState(null);
            setSelectedCvrSourceKey("auto");
            setEventDetectionSourceKey("auto");
            setTranscriptionCvrSourceKey("auto");
            return;
        }

        if (lastLinkedCaseRef.current === caseNumber) {
            return;
        }

        if (selectedCase?.id === caseNumber) {
            lastLinkedCaseRef.current = caseNumber;
            if (!isLinkedRoute && workflowStage === "caseDetails") {
                setWorkflowStage("analysis");
            }
            return;
        }

        let isMounted = true;
        setLinkError("");
        setMissingDataTypes([]);

        fetchCaseByNumber(caseNumber)
            .then((data) => {
                if (!isMounted) {
                    return;
                }

                const evaluation = evaluateModuleReadiness(data, "cvr");
                const preview = buildCasePreview(data);
                if (!evaluation.ready) {
                    setLinkError(evaluation.message);
                    setMissingDataTypes(evaluation.missingTypes || []);
                    setSelectedCase(preview);
                    setSelectedCaseData(data);
                    setWorkflowStage("cvrUpload");
                    lastLinkedCaseRef.current = caseNumber;
                    return;
                }

                if (viaCaseDetailsFlowRef.current) {
                    // Arrived via the Case Details picker (not a direct case link) — walk
                    // through Upload/Edit and Review even though data already exists,
                    // instead of jumping straight into Analysis.
                    setSelectedCase(preview);
                    setSelectedCaseData(data);
                    setLinkError("");
                    setMissingDataTypes([]);
                    setWorkflowStage("cvrUpload");
                    lastLinkedCaseRef.current = caseNumber;
                    return;
                }

                setSelectedCase(preview);
                setSelectedCaseData(data);
                setActiveTab("denoise");
                setShowResults(false);
                setDenoisedAudioUrl("");
                setOriginalAudioUrl("");
                setDenoiseMethod("facebook_denoiser");
                setSelectedCvrSourceKey("auto");
                setEventDetectionSourceKey("auto");
                setTranscriptionCvrSourceKey("auto");
                setWorkflowStage("analysis");
                lastLinkedCaseRef.current = caseNumber;
                setLinkError("");
                setMissingDataTypes([]);
            })
            .catch((err) => {
                if (!isMounted) {
                    return;
                }

                setLinkError(err?.message || "Unable to open the selected case");
                setMissingDataTypes([]);
                setSelectedCase(null);
                setSelectedCaseData(null);
                setWorkflowStage(isLinkedRoute ? "analysis" : "caseDetails");
            });

        return () => {
            isMounted = false;
        };
    }, [caseNumber, navigate, selectedCase, workflowStage, isLinkedRoute]);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (caseMenuRef.current && !caseMenuRef.current.contains(event.target)) {
                setShowCaseMenu(false);
            }
        };

        if (showCaseMenu) {
            document.addEventListener("mousedown", handleClickOutside);
        }

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [showCaseMenu]);

    useEffect(() => {
        if (!caseNumber || !selectedCaseData) {
            return;
        }

        const storedPipeline = (() => {
            if (!pipelineStorageKey) {
                return null;
            }

            try {
                const raw = window.localStorage.getItem(pipelineStorageKey);
                return raw ? JSON.parse(raw) : null;
            } catch (_error) {
                return null;
            }
        })();

        const casePipeline = selectedCaseData?.analyses?.cvr?.pipeline;
        // The server also computes its own `analyses.cvr.pipeline.stepStatuses` summary
        // for cases that have never called the pipeline-persistence endpoint — that shape
        // has no `.steps`, which is what this UI actually reads from. Only trust a
        // server-provided pipeline if it's in the shape we persist ourselves.
        const hasValidSteps = casePipeline && typeof casePipeline.steps === "object" && casePipeline.steps !== null;
        let initialPipeline = (hasValidSteps ? casePipeline : null) || storedPipeline || buildInitialPipeline();

        if (cvrAttachments.length > 0) {
            initialPipeline = clearStaleAudioErrors(initialPipeline);
        }

        pipelineInitializedRef.current = false;
        setPipelineState(initialPipeline);
        setActiveTab(initialPipeline.current || "denoise");
    }, [caseNumber, selectedCaseData, pipelineStorageKey, buildInitialPipeline, cvrAttachments, clearStaleAudioErrors]);

    useEffect(() => {
        if (!resolvedCaseNumber || !pipelineState) {
            return;
        }

        if (!pipelineInitializedRef.current) {
            pipelineInitializedRef.current = true;
            return;
        }

        if (pipelineStorageKey) {
            try {
                window.localStorage.setItem(pipelineStorageKey, JSON.stringify(pipelineState));
            } catch (_error) {
                // ignore storage errors
            }
        }

        updateCvrPipeline(resolvedCaseNumber, pipelineState).catch(() => {
            // ignore persistence failures to keep UI responsive
        });
    }, [pipelineState, pipelineStorageKey, resolvedCaseNumber, updateCvrPipeline]);


    useEffect(() => {
        if (pipelineState?.current) {
            setActiveTab(pipelineState.current);
        }
    }, [pipelineState?.current]);


    useEffect(() => {
        if (!isLinkedRoute && workflowStage === "caseDetails") {
            setShowResults(false);
        }
    }, [workflowStage]);

    useEffect(() => {
        let isMounted = true;

        const loadOriginalAudio = async () => {
            if (!selectedCvrAttachment) {
                setOriginalAudioUrl("");
                return;
            }

            try {
                const target = await createDownloadTarget({
                    bucket: selectedCvrAttachment.storage?.bucket,
                    objectKey: selectedCvrAttachment.storage?.objectKey,
                    fileName: selectedCvrAttachment.name || "cvr-audio.wav",
                    contentType: selectedCvrAttachment.contentType || "audio/wav",
                });
                if (isMounted) {
                    setOriginalAudioUrl(target?.downloadUrl || "");
                }
            } catch (_error) {
                if (isMounted) {
                    setOriginalAudioUrl("");
                }
            }
        };

        loadOriginalAudio();

        return () => {
            isMounted = false;
        };
    }, [selectedCvrAttachment]);

    useEffect(() => {
        return () => {
            if (denoisedAudioUrl) {
                URL.revokeObjectURL(denoisedAudioUrl);
            }
        };
    }, [denoisedAudioUrl]);

    const fetchDenoisedAudio = useCallback(async (downloadUrl) => {
        if (!downloadUrl) {
            return;
        }

        const token = window?.localStorage?.getItem("authToken");
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(downloadUrl, { headers });
        if (!response.ok) {
            throw new Error(`Unable to download denoised audio (status ${response.status})`);
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        setDenoisedAudioUrl((prev) => {
            if (prev) {
                URL.revokeObjectURL(prev);
            }
            return objectUrl;
        });
    }, []);

    useEffect(() => {
        const outputUrl = pipelineState?.steps?.denoise?.output?.downloadUrl;
        if (outputUrl && !denoisedAudioUrl) {
            fetchDenoisedAudio(outputUrl).catch(() => {
                // ignore fetch errors; local output may still be available
            });
        }
    }, [pipelineState, denoisedAudioUrl, fetchDenoisedAudio]);

    const getStepData = useCallback(
        (key) => pipelineState?.steps?.[key] || { status: "pending" },
        [pipelineState]
    );

    const setStepData = useCallback(
        (key, updates) => {
            updatePipelineState((state) => ({
                ...state,
                steps: {
                    ...state.steps,
                    [key]: {
                        ...state.steps[key],
                        ...updates,
                        updatedAt: new Date().toISOString(),
                    },
                },
            }));
        },
        [updatePipelineState]
    );

    const startStep = useCallback(
        (key) => {
            updatePipelineState((state) => ({
                ...state,
                current: key,
                steps: {
                    ...state.steps,
                    [key]: {
                        ...state.steps[key],
                        status: "running",
                        error: "",
                        updatedAt: new Date().toISOString(),
                    },
                },
            }));
        },
        [updatePipelineState]
    );

    const advanceToNextStep = useCallback((state, fromKey) => {
        const startIndex = analysisStages.findIndex((step) => step.key === fromKey);
        for (let i = startIndex + 1; i < analysisStages.length; i += 1) {
            const key = analysisStages[i].key;
            if (state.steps[key]?.status === "pending") {
                return { ...state, current: key };
            }
        }

        return { ...state, current: null };
    }, []);

    const completeStep = useCallback(
        (key, output) => {
            updatePipelineState((state) => ({
                ...state,
                current: key,
                steps: {
                    ...state.steps,
                    [key]: {
                        ...state.steps[key],
                        status: "completed",
                        output: output || state.steps[key]?.output || null,
                        updatedAt: new Date().toISOString(),
                    },
                },
            }));
        },
        [updatePipelineState]
    );

    const skipStep = useCallback(
        (key) => {
        updatePipelineState((state) => {
            const nextState = {
                ...state,
                steps: {
                    ...state.steps,
                    [key]: {
                        ...state.steps[key],
                        status: "skipped",
                        updatedAt: new Date().toISOString(),
                    },
                },
            };

            if (key === "denoise") {
                setDenoiseSkipNotice(
                    "Denoising was skipped. Transcription will run on the original audio.",
                );
            }

            return advanceToNextStep(nextState, key);
        });
        },
        [advanceToNextStep, updatePipelineState]
    );

    const runDenoise = useCallback(async () => {
        const targetCaseNumber = caseNumber || selectedCase?.id;
        if (!targetCaseNumber || !selectedCvrAttachment) {
            setStepData("denoise", {
                status: "error",
                error: "CVR audio is not available for this case.",
            });
            return;
        }

        startStep("denoise");
        setDenoisedAudioUrl("");

        try {
            const result = await runCvrDenoise(targetCaseNumber, {
                method: denoiseMethod,
                sourceObjectKey: selectedCvrSourceKey !== "auto" ? selectedCvrSourceKey : null,
            });
            const preferredDownloadUrl = result?.downloadUrl || result?.minioDownloadUrl;
            await fetchDenoisedAudio(preferredDownloadUrl);
            const previousHistory = getStepData("denoise").outputHistory || [];
            const historyEntry = {
                outputId: result?.outputId || "",
                createdAt: new Date().toISOString(),
                saved: false,
                downloadUrl: preferredDownloadUrl || null,
            };
            completeStep("denoise", {
                outputId: result?.outputId || null,
                downloadUrl: preferredDownloadUrl || null,
                outputHistory: [historyEntry, ...previousHistory],
            });
            setStepData("denoise", { outputHistory: [historyEntry, ...previousHistory] });
            setDenoiseHistoryNotice(
                "New denoise output created. Save any outputs you want to keep for future review.",
            );
        } catch (error) {
            setStepData("denoise", {
                status: "error",
                error: error?.message || "Failed to denoise audio.",
            });
        }
    }, [
        caseNumber,
        selectedCase,
        selectedCvrAttachment,
        denoiseMethod,
        fetchDenoisedAudio,
        setStepData,
        completeStep,
        startStep,
        getStepData,
        selectedCvrSourceKey,
    ]);

    const runChannelSeparation = useCallback(async () => {
        const targetCaseNumber = caseNumber || selectedCase?.id;
        if (!targetCaseNumber || !selectedCvrAttachment) {
            setStepData("channels", {
                status: "error",
                error: "CVR audio is not available for this case.",
            });
            return;
        }

        startStep("channels");

        try {
            const result = await runCvrChannelSeparation(targetCaseNumber, {
                sourceObjectKey: channelSeparationSourceKey !== "auto" ? channelSeparationSourceKey : null,
            });
            completeStep("channels", {
                channels: result?.channels || [],
            });
        } catch (error) {
            setStepData("channels", {
                status: "error",
                error: error?.message || "Failed to separate channels.",
            });
        }
    }, [
        caseNumber,
        selectedCase,
        selectedCvrAttachment,
        channelSeparationSourceKey,
        setStepData,
        completeStep,
        startStep,
    ]);

    const progressSteps = analysisStages.map((stage) => {
        const stepStatus = getStepData(stage.key).status || "pending";
        let status = "upcoming";

        if (stepStatus === "completed") {
            status = "complete";
        } else if (stepStatus === "skipped") {
            status = "skipped";
        } else if (stepStatus === "error") {
            status = "error";
        } else if (pipelineState?.current === stage.key || stepStatus === "running") {
            status = "current";
        }

        return { ...stage, status, isActive: showResults && activeTab === stage.key };
    });

    const currentStage = progressSteps.find((step) => step.status === "current");
    const activeStageLabel = analysisStages.find((stage) => stage.key === activeTab)?.label || "Not started";
    const completedCount = analysisStages.filter((stage) => {
        const status = getStepData(stage.key).status;
        return status === "completed" || status === "skipped";
    }).length;
    const progressPercent = Math.round((completedCount / analysisStages.length) * 100);
    const hasStarted = showResults || completedCount > 0 || getStepData("denoise").status !== "pending";
    const denoiseStep = getStepData("denoise");
    const channelsStep = getStepData("channels");
    const transcriptionStep = getStepData("transcription");
    const rolesStep = getStepData("roles");
    const emotionStep = getStepData("emotion");
    const eventDetection = pipelineState?.eventDetection || { status: "idle", events: [] };
    const eventDetectionEvents = eventDetection.events || [];
    const isTranscriptionComplete = transcriptionStep.status === "completed";
    const hasDiarizedTranscript = Boolean(
        transcriptionStep.output?.diarizedTranscript?.length ||
            transcriptionStep.output?.diarization?.length,
    );
    const isRoleIdentificationReady = isTranscriptionComplete && hasDiarizedTranscript;
    const denoiseReady = ["completed", "skipped"].includes(denoiseStep.status);
    const canSelectTranscriptionChannel =
        transcriptionSource === "original" ||
        (transcriptionSource === "auto" && denoiseStep.status !== "completed");
    const goToStep = useCallback((key) => {
        if (!key) {
            return;
        }
        updatePipelineState((state) => ({
            ...state,
            current: key,
        }));
        setActiveTab(key);
    }, [updatePipelineState]);
    const warnTranscriptionDependency = useCallback((message, title = "Transcription required") => {
        setTranscriptionBlockerTitle(title);
        setTranscriptionBlocker(message);
    }, []);

    useEffect(() => {
        if (activeTab !== "roles") {
            return;
        }
        if (!isTranscriptionComplete) {
            warnTranscriptionDependency(
                "Role identification requires transcription. Complete it to continue (skipping keeps role identification and final insights locked).",
            );
            return;
        }
        if (!hasDiarizedTranscript) {
            warnTranscriptionDependency(
                "This transcript has no diarized speaker segments. Go back to Transcription, enable \"Enable speaker diarization\", and re-run it before continuing.",
                "Diarization required",
            );
        }
    }, [activeTab, isTranscriptionComplete, hasDiarizedTranscript, warnTranscriptionDependency]);

    const runTranscription = useCallback(async () => {
        const targetCaseNumber = caseNumber || selectedCase?.id;
        if (!targetCaseNumber) {
            setStepData("transcription", {
                status: "error",
                error: "No case selected for transcription.",
            });
            return;
        }

        const resolvedSource =
            transcriptionSource === "auto"
                ? denoiseStep.status === "completed"
                    ? "denoised"
                    : "original"
                : transcriptionSource;
        if (resolvedSource === "denoised" && denoiseStep.status !== "completed") {
            setTranscriptionBlocker(
                "Denoised audio is not available yet. Run denoise or switch to original audio to continue.",
            );
            return;
        }

        startStep("transcription");
        try {
            const sourceObjectKey =
                resolvedSource === "original" && transcriptionCvrSourceKey !== "auto"
                    ? transcriptionCvrSourceKey
                    : null;
            const result = await runCvrTranscription(targetCaseNumber, {
                model: transcriptionModel,
                modelType: "transformers",
                useTimestamps: enableDiarization ? true : false,
                diarization: enableDiarization,
                source: resolvedSource,
                sourceObjectKey,
            });
            const sourceLabel = result?.source === "denoised" ? "denoised audio" : "original audio";
            const output = {
                summary: `Transcription completed. Source: ${sourceLabel}.`,
                transcriptText: result?.transcriptText || "",
                diarizationEnabled: enableDiarization,
                diarization: result?.diarization || null,
                diarizedTranscript: result?.diarizedTranscript || null,
                diarizationError: result?.diarizationError || null,
                model: transcriptionModel,
            };
            completeStep("transcription", output);
        } catch (error) {
            setStepData("transcription", {
                status: "error",
                error: error?.message || "Failed to run transcription.",
            });
        }
    }, [
        caseNumber,
        selectedCase,
        startStep,
        completeStep,
        enableDiarization,
        transcriptionModel,
        transcriptionSource,
        transcriptionCvrSourceKey,
        setStepData,
    ]);

    const runRoleIdentification = useCallback(async () => {
        const targetCaseNumber = caseNumber || selectedCase?.id;
        if (!targetCaseNumber) {
            setStepData("roles", {
                status: "error",
                error: "No case selected for role identification.",
            });
            return;
        }

        if (!hasDiarizedTranscript) {
            setStepData("roles", {
                status: "error",
                error: "This transcript has no diarized speaker segments. Enable speaker diarization on the Transcription step and re-run it first.",
            });
            return;
        }

        startStep("roles");
        try {
            const result = await runCvrRoleIdentification(targetCaseNumber, {});
            const output = {
                summary: result?.summary || "Role identification completed.",
                speakerRoles: result?.speakerRoles || {},
                utterances: result?.utterances || [],
            };
            completeStep("roles", output);
        } catch (error) {
            setStepData("roles", {
                status: "error",
                error: error?.message || "Failed to run role identification.",
            });
        }
    }, [caseNumber, selectedCase, startStep, completeStep, setStepData, hasDiarizedTranscript]);

    const runEventDetection = useCallback(async () => {
        const targetCaseNumber = caseNumber || selectedCase?.id;
        if (!targetCaseNumber) {
            updatePipelineState((state) => ({
                ...state,
                steps: {
                    ...state.steps,
                    events: {
                        ...state.steps?.events,
                        status: "error",
                        error: "No case selected for event detection.",
                    },
                },
                eventDetection: {
                    status: "error",
                    events: [],
                    error: "No case selected for event detection.",
                },
            }));
            return;
        }

        updatePipelineState((state) => ({
            ...state,
            steps: {
                ...state.steps,
                events: {
                    ...state.steps?.events,
                    status: "running",
                    error: "",
                },
            },
            eventDetection: {
                ...(state?.eventDetection || {}),
                status: "running",
                error: "",
            },
        }));

        try {
            const result = await runCvrEventDetection(targetCaseNumber, {
                ...eventDetectionConfig,
                sourceObjectKey: eventDetectionSourceKey !== "auto" ? eventDetectionSourceKey : null,
            });
            updatePipelineState((state) => ({
                ...state,
                steps: {
                    ...state.steps,
                    events: {
                        ...state.steps?.events,
                        status: "completed",
                        output: {
                            count: result?.events?.length || 0,
                        },
                        error: "",
                    },
                },
                eventDetection: {
                    status: "completed",
                    events: result?.events || [],
                    error: "",
                },
            }));
        } catch (error) {
            updatePipelineState((state) => ({
                ...state,
                steps: {
                    ...state.steps,
                    events: {
                        ...state.steps?.events,
                        status: "error",
                        error: error?.message || "Failed to run event detection.",
                    },
                },
                eventDetection: {
                    status: "error",
                    events: [],
                    error: error?.message || "Failed to run event detection.",
                },
            }));
        }
    }, [caseNumber, selectedCase, eventDetectionConfig, eventDetectionSourceKey, updatePipelineState]);

    const runEmotionRecognition = useCallback(async () => {
        const targetCaseNumber = selectedCase?.id || caseNumber;
        if (!targetCaseNumber) {
            return;
        }
        startStep("emotion");
        try {
            const result = await runCvrEmotionAnalysis(targetCaseNumber);
            const label = result?.emotion?.label;
            const output = {
                summary: label ? `Detected emotion: ${label}` : "Emotion recognition completed.",
                emotion: result?.emotion,
            };
            completeStep("emotion", output);
        } catch (error) {
            updatePipelineState((state) => ({
                ...state,
                steps: {
                    ...state.steps,
                    emotion: {
                        ...state.steps?.emotion,
                        status: "error",
                        error: error?.message || "Failed to run emotion recognition.",
                    },
                },
            }));
        }
    }, [caseNumber, selectedCase, startStep, completeStep, updatePipelineState]);
    const hasProgress =
        analysisStages.some((stage) => {
            const status = getStepData(stage.key).status;
            return status && status !== "pending";
        });
    const allStepsResolved = analysisStages.every((stage) => {
        const status = getStepData(stage.key).status;
        return status === "completed" || status === "skipped";
    });
    const analysisStatusLabel = pipelineState?.insightsGenerated
        ? "Insights generated"
        : allStepsResolved
            ? "Pipeline complete"
        : hasProgress
            ? "Analysis in progress"
            : "Ready for analysis";

    const stepperDisplayStages = (() => {
        const grouped = [];
        let analysisNode = null;

        progressSteps.forEach((step) => {
            if (step.group === "analysis") {
                if (!analysisNode) {
                    analysisNode = {
                        key: "analysis-group",
                        label: "Analysis",
                        description: "Tone, workload, and crew coordination.",
                        status: step.status,
                        isActive: step.isActive,
                        statuses: [step.status],
                    };
                    grouped.push(analysisNode);
                } else {
                    analysisNode.statuses.push(step.status);
                    analysisNode.isActive = analysisNode.isActive || step.isActive;
                }
                return;
            }

            grouped.push(step);
        });

        if (analysisNode) {
            const { statuses } = analysisNode;
            if (statuses.some((status) => status === "error")) {
                analysisNode.status = "error";
            } else if (statuses.some((status) => status === "current")) {
                analysisNode.status = "current";
            } else if (statuses.every((status) => status === "complete" || status === "skipped")) {
                analysisNode.status = statuses.every((status) => status === "skipped") ? "skipped" : "complete";
            } else {
                analysisNode.status = "upcoming";
            }
            delete analysisNode.statuses;
        }

        grouped.push({
            key: "report",
            label: "CVR Analysis Report",
            description: "Export the final cockpit voice analysis report.",
            status: activeTab === "report" ? "current" : allStepsResolved ? "current" : "upcoming",
            isActive: activeTab === "report",
            onClick: () => goToStep("report"),
        });

        return grouped;
    })();

    const generateFinalInsights = useCallback(() => {
        const caseId = selectedCase?.id || caseNumber;
        if (!caseId) {
            return;
        }
        if (!hasProgress) {
            setTranscriptionBlocker(
                "Run at least one CVR step before generating a report.",
            );
            return;
        }
        navigate("/reports", {
            state: {
                caseNumber: caseId,
                autoGenerate: true,
            },
        });
    }, [caseNumber, hasProgress, navigate, selectedCase?.id, setTranscriptionBlocker]);

    const formattedTranscript = useMemo(() => {
        const rawText = transcriptionStep.output?.transcriptText || "";
        if (!rawText) {
            return "";
        }
        const sentences = rawText.split(/(?<=[.!?])\s+/);
        return sentences.map((sentence) => sentence.trim()).filter(Boolean).join("\n");
    }, [transcriptionStep.output?.transcriptText]);

    const escapeHtml = useCallback((value) => {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }, []);

    const handleExportTranscript = useCallback(
        (format) => {
            const diarizedTranscript = transcriptionStep.output?.diarizedTranscript || [];
            const transcriptText = transcriptionStep.output?.transcriptText || "";
            if (!transcriptText && diarizedTranscript.length === 0) {
                return;
            }

            const caseLabel = selectedCase?.id || "case";
            const exportText =
                diarizedTranscript.length > 0
                    ? diarizedTranscript
                          .map((segment) => {
                              const start = segment.start != null ? segment.start.toFixed(2) : "--";
                              const end = segment.end != null ? segment.end.toFixed(2) : "--";
                              const speaker = segment.speaker || "Speaker";
                              return `[${start} -> ${end}] ${speaker}: ${segment.text || ""}`.trim();
                          })
                          .join("\n")
                    : transcriptText;
            if (format === "pdf") {
                const printWindow = window.open("", "_blank");
                if (!printWindow) {
                    return;
                }
                const safeText = escapeHtml(exportText);
                printWindow.document.write(
                    `<!doctype html><html><head><title>CVR Transcript</title></head><body><pre style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${safeText}</pre></body></html>`,
                );
                printWindow.document.close();
                printWindow.focus();
                printWindow.print();
                return;
            }

            const safeText = escapeHtml(exportText);
            const wordHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${safeText}</pre></body></html>`;
            const blob = new Blob([wordHtml], { type: "application/msword" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `cvr-transcript-${caseLabel}.doc`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        },
        [
            escapeHtml,
            selectedCase,
            transcriptionStep.output?.transcriptText,
            transcriptionStep.output?.diarizedTranscript,
        ]
    );
    const progressBlock = (
        <>
            <div>
                <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>Pipeline progress</span>
                    <span>{progressPercent}%</span>
                </div>
                <div className="mt-2 h-2 w-full rounded-full bg-gray-200">
                    <div
                        className={`h-2 rounded-full bg-emerald-500 transition-all ${denoiseStep.status === "running" ? "animate-pulse" : ""}`}
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
                <p className="mt-2 text-sm font-medium text-emerald-600">
                    Active step: {activeStageLabel}
                </p>
            </div>

            <div className="flex flex-col lg:flex-row items-center gap-4">
                {stepperDisplayStages.map((step, index) => {
                    const { key: stageKey, ...stepProps } = step;
                    return (
                        <React.Fragment key={stageKey || step.label}>
                            <ProgressStep {...stepProps} />
                            {index < stepperDisplayStages.length - 1 && (
                                <div className="hidden lg:block h-px flex-1 bg-gray-200" />
                            )}
                        </React.Fragment>
                    );
                })}
            </div>
        </>
    );

    const handleStartAnalysis = () => {
        if (!selectedCase) return;
        if (selectedCaseData) {
            const evaluation = evaluateModuleReadiness(selectedCaseData, "cvr");
            if (!evaluation.ready) {
                setLinkError(evaluation.message);
                setMissingDataTypes(evaluation.missingTypes || []);
                setShowResults(false);
                return;
            }
        }
        setWorkflowStage("analysis");
        setShowResults(true);
        setActiveTab("denoise");
        if (!pipelineState) {
            updatePipelineState(buildInitialPipeline());
        }
    };

    const handleViewResults = () => {
        setShowResults(true);
        setActiveTab("denoise");
    };

    const handleChangeCase = () => {
        if (isLinkedRoute) {
            navigate("/cases");
            return;
        }
        setSelectedCase(null);
        setSelectedCaseData(null);
        setWorkflowStage("caseDetails");
        setShowResults(false);
        setDenoisedAudioUrl("");
        setOriginalAudioUrl("");
        setDenoiseMethod("facebook_denoiser");
        setSelectedCvrSourceKey("auto");
        setEventDetectionSourceKey("auto");
        setTranscriptionCvrSourceKey("auto");
        setPipelineState(null);
        setLinkError("");
        setMissingDataTypes([]);
    };

    const handleResetPipeline = () => {
        if (!caseNumber) {
            return;
        }

        const shouldReset = window.confirm("Reset the CVR pipeline for this case? This will clear all step progress.");
        if (!shouldReset) {
            return;
        }

        const next = buildInitialPipeline();
        setSelectedCvrSourceKey("auto");
        setEventDetectionSourceKey("auto");
        setTranscriptionCvrSourceKey("auto");
        setPipelineState(next);
        setDenoisedAudioUrl((prev) => {
            if (prev) {
                URL.revokeObjectURL(prev);
            }
            return "";
        });
        setTranscriptionBlocker("");
        setTranscriptionSkipPrompt(false);
        setShowResults(true);
        setActiveTab(next.current || "denoise");
    };

    const denoiseHistory = denoiseStep.outputHistory || denoiseStep.output?.outputHistory || [];
    const currentDenoiseId = denoiseStep.output?.outputId;

    const handleSaveDenoiseOutput = (outputId) => {
        updatePipelineState((state) => {
            const history = state.steps?.denoise?.outputHistory || [];
            return {
                ...state,
                steps: {
                    ...state.steps,
                    denoise: {
                        ...state.steps.denoise,
                        outputHistory: history.map((entry) =>
                            entry.outputId === outputId ? { ...entry, saved: true } : entry,
                        ),
                    },
                },
            };
        });
    };

    const confirmDeleteDenoiseOutput = (entry) => {
        setDeleteDenoiseTarget(entry);
    };

    const handleDeleteDenoiseOutput = async () => {
        if (!deleteDenoiseTarget || !caseNumber) {
            setDeleteDenoiseTarget(null);
            return;
        }

        const targetId = deleteDenoiseTarget.outputId;
        try {
            await deleteCvrDenoiseOutput(caseNumber, targetId);
        } catch (_error) {
            // ignore delete failures; UI state will still update
        }

        updatePipelineState((state) => {
            const history = state.steps?.denoise?.outputHistory || [];
            const filtered = history.filter((entry) => entry.outputId !== targetId);
            const nextOutput =
                state.steps?.denoise?.output?.outputId === targetId
                    ? null
                    : state.steps?.denoise?.output;
            return {
                ...state,
                steps: {
                    ...state.steps,
                    denoise: {
                        ...state.steps.denoise,
                        output: nextOutput,
                        outputHistory: filtered,
                        status: nextOutput ? state.steps.denoise.status : "pending",
                    },
                },
            };
        });

        if (currentDenoiseId === targetId) {
            setDenoisedAudioUrl("");
        }

        setDeleteDenoiseTarget(null);
    };

    const handleNavigateToCases = () => {
        navigate("/cases");
    };

    const handleUploadMissingData = () => {
        if (!caseNumber) {
            return;
        }

        const normalizedMissing = missingDataTypes.map((type) => String(type || "").toLowerCase());
        const hasFdr = normalizedMissing.includes("fdr");
        const hasCvr = normalizedMissing.includes("cvr");

        let focusUpload = "";
        if (hasFdr && hasCvr) {
            focusUpload = "both";
        } else if (hasFdr) {
            focusUpload = "fdr";
        } else if (hasCvr) {
            focusUpload = "cvr";
        }

        navigate("/cases", {
            state: {
                editCaseNumber: caseNumber,
                focusUpload,
                attemptedCase: caseNumber,
            },
        });
    };

    const analysisAudioComparisons = useMemo(
        () => [
            {
                id: "original",
                title: "Original Cockpit Mix",
                description: "Raw CVR capture prior to enhancement.",
                src: originalAudioUrl,
                downloadName: "cvr-original.wav",
            },
            {
                id: "denoised",
                title: "Denoised Output",
                description: "Noise-reduced mix tailored for transcription.",
                src: denoisedAudioUrl,
                downloadName: "cvr-denoised.wav",
            },
        ],
        [originalAudioUrl, denoisedAudioUrl]
    );

    const cvrAttachmentList = useMemo(() => {
        if (!selectedCaseData || !Array.isArray(selectedCaseData.attachments)) {
            return [];
        }
        return selectedCaseData.attachments.filter(
            (item) => String(item?.type || "").toUpperCase() === "CVR",
        );
    }, [selectedCaseData]);

    const loadAttachmentAudio = useCallback(
        async (attachment) => {
            if (!attachment?.storage?.bucket || !attachment?.storage?.objectKey) {
                return;
            }
            const key = attachment.storage.objectKey;
            try {
                const target = await createDownloadTarget({
                    bucket: attachment.storage.bucket,
                    objectKey: key,
                    fileName: attachment.name || "cvr-audio.wav",
                    contentType: attachment.contentType || "audio/wav",
                });
                setEventAudioUrls((prev) => ({ ...prev, [key]: target?.downloadUrl || "" }));
            } catch (_error) {
                setEventAudioUrls((prev) => ({ ...prev, [key]: "" }));
            }
        },
        [setEventAudioUrls],
    );

    const canOfferUpload = isLinkedRoute && missingDataTypes.length > 0;

    if (!isLinkedRoute && workflowStage === "caseDetails") {
        return <CvrCaseDetailsStep />;
    }

    if (workflowStage === "cvrUpload" && selectedCase && selectedCaseData) {
        return (
            <CvrUploadStep
                caseNumber={selectedCase.id}
                caseData={selectedCaseData}
                cvrChannelOptions={cvrChannelOptions}
                bannerMessage={linkError}
                onUploaded={(updated) => {
                    setSelectedCaseData(updated);
                    setSelectedCase(buildCasePreview(updated));
                    setLinkError("");
                    setMissingDataTypes([]);
                    setWorkflowStage("review");
                }}
            />
        );
    }

    if (workflowStage === "review" && selectedCase && selectedCaseData) {
        return (
            <CvrReviewStep
                caseNumber={selectedCase.id}
                caseData={selectedCaseData}
                onBack={() => setWorkflowStage("cvrUpload")}
                onConfirm={() => {
                    setActiveTab("denoise");
                    setWorkflowStage("analysis");
                    if (!pipelineState) {
                        updatePipelineState(buildInitialPipeline());
                    }
                }}
            />
        );
    }

    if (workflowStage === "analysis" && !selectedCase) {
      if (linkError) {
            return (
                <div className="max-w-3xl mx-auto py-24 text-center space-y-6">
                    <div className="space-y-2">
                        <h1 className="text-3xl font-semibold text-gray-900">Unable to open case</h1>
                        <p className="text-sm text-gray-600">{linkError}</p>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:justify-center gap-3">
                        <button
                            type="button"
                            onClick={handleNavigateToCases}
                            className="inline-flex items-center justify-center rounded-lg border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                            Back to cases
                        </button>
                        {canOfferUpload ? (
                            <button
                                type="button"
                                onClick={handleUploadMissingData}
                                className="inline-flex items-center justify-center rounded-lg border border-emerald-500 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
                            >
                                Upload required data
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => {
                                    if (isLinkedRoute) {
                                        handleNavigateToCases();
                                        return;
                                    }
                                    setWorkflowStage("caseDetails");
                                    setLinkError("");
                                }}
                                className="inline-flex items-center justify-center rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                            >
                                Choose another case
                            </button>
                        )}
                    </div>
                </div>
            );
        }

        return (
            <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-4 py-24 text-center">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-600" />
                <div className="space-y-1">
                    <p className="text-sm font-semibold text-emerald-600">Preparing cockpit voice analysis</p>
                    <p className="text-sm text-gray-600">
                        Loading the selected case details. This will start automatically.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto space-y-8">
            <CvrPhaseStepper
                currentPhase="analysis"
                onPhaseClick={(key) => {
                    if (key === "details") {
                        navigate("/cases/cvr", { state: { editCaseNumber: caseNumber || selectedCase?.id } });
                    } else if (key === "upload") {
                        setWorkflowStage("cvrUpload");
                    } else if (key === "review") {
                        setWorkflowStage("review");
                    }
                }}
            />
            {denoiseSkipNotice && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-amber-700">Denoise skipped</p>
                                <p className="mt-2 text-sm text-gray-600">{denoiseSkipNotice}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDenoiseSkipNotice("")}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mt-6 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setDenoiseSkipNotice("")}
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {denoiseHistoryNotice && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-amber-700">Denoise history updated</p>
                                <p className="mt-2 text-sm text-gray-600">{denoiseHistoryNotice}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDenoiseHistoryNotice("")}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mt-6 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setDenoiseHistoryNotice("")}
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {missingCvrChannelPrompt && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-amber-700">Channel not uploaded</p>
                                <p className="mt-2 text-sm text-gray-600">
                                    {missingCvrChannelPrompt.label} is not available for this case. Upload it now?
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setMissingCvrChannelPrompt(null)}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setMissingCvrChannelPrompt(null)}
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
                            >
                                No
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setMissingCvrChannelPrompt(null);
                                    navigate("/cases", {
                                        state: {
                                            editCaseNumber: selectedCase?.id || caseNumber,
                                            focusUpload: "cvr",
                                        },
                                    });
                                }}
                                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                            >
                                Yes, upload now
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {deleteDenoiseTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-rose-700">Delete denoise output</p>
                                <p className="mt-2 text-sm text-gray-600">
                                    This will remove the selected output from local storage and MinIO.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDeleteDenoiseTarget(null)}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setDeleteDenoiseTarget(null)}
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleDeleteDenoiseOutput}
                                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {transcriptionBlocker && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-amber-700">{transcriptionBlockerTitle}</p>
                                <p className="mt-2 text-sm text-gray-600">{transcriptionBlocker}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setTranscriptionBlocker("")}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mt-6 flex flex-wrap justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setTranscriptionBlocker("")}
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
                            >
                                Close
                            </button>
                            {activeTab !== "transcription" && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setTranscriptionBlocker("");
                                        goToStep("transcription");
                                    }}
                                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                                >
                                    Go to Transcription
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {transcriptionSkipPrompt && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-amber-700">Skip transcription?</p>
                                <p className="mt-2 text-sm text-gray-600">
                                    Transcription is required for role identification and final insights. If you skip it, those
                                    outputs will remain locked until transcription is completed.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setTranscriptionSkipPrompt(false)}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setTranscriptionSkipPrompt(false)}
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setTranscriptionSkipPrompt(false);
                                    skipStep("transcription");
                                }}
                                className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white"
                            >
                                Skip anyway
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <header className="bg-white border border-gray-200 rounded-2xl p-6">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div>
                        <p className="text-sm font-semibold text-emerald-600">CVR Module</p>
                        <h1 className="text-3xl font-bold text-gray-900">Cockpit Voice Analysis</h1>
                        <p className="text-gray-500 mt-2 max-w-2xl">
                            Select an investigation case and initiate the CVR analysis pipeline to generate enhanced investigative insights.
                        </p>
                    </div>
                    <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">
                        <Sparkles className="w-6 h-6 text-emerald-500" />
                        <div>
                            <p className="text-sm font-semibold text-emerald-700">AI-Assisted Analysis</p>
                            <p className="text-xs text-emerald-600">
                                Noise reduction · Speaker separation · Transcription · Human-factor indicators
                            </p>
                        </div>
                    </div>
                </div>
            </header>

            {workflowStage === "analysis" && selectedCase && (
                <section className="bg-white border border-gray-200 rounded-2xl p-6 space-y-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Investigation Case</p>
                            <h2 className="text-2xl font-semibold text-gray-900">Case ID: {selectedCase.id}</h2>
                            <p className="text-sm text-gray-500 mt-1">Status: {analysisStatusLabel}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setWorkflowStage("review")}
                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                            >
                                Back to Review
                            </button>
                            {hasStarted && (
                                <>
                                    <button
                                        type="button"
                                        onClick={generateFinalInsights}
                                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition"
                                    >
                                        Generate Report
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleResetPipeline}
                                        className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition hover:bg-amber-50"
                                    >
                                        Reset pipeline
                                    </button>
                                </>
                            )}
                            <div ref={caseMenuRef} className="relative inline-flex items-center">
                                <button
                                    type="button"
                                    onClick={handleChangeCase}
                                    className="inline-flex items-center gap-2 rounded-l-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:border-emerald-300 hover:text-emerald-600"
                                >
                                    Change case
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowCaseMenu((prev) => !prev)}
                                    className="inline-flex items-center rounded-r-xl border border-l-0 border-gray-200 px-3 py-2 text-sm text-gray-500 hover:text-emerald-600"
                                    aria-label="Select another case"
                                >
                                    <ChevronRight className={`w-4 h-4 transition-transform ${showCaseMenu ? "rotate-90" : ""}`} />
                                </button>
                                {showCaseMenu && (
                                    <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-gray-200 bg-white shadow-lg z-20">
                                        <div className="px-4 py-2 text-xs font-semibold text-gray-500">Recent CVR-ready cases</div>
                                        {cvrReadyCases.length === 0 ? (
                                            <div className="px-4 py-3 text-sm text-gray-500">
                                                No recent CVR-ready cases.
                                            </div>
                                        ) : (
                                            cvrReadyCases.map((caseItem) => (
                                                <button
                                                    key={caseItem.caseNumber}
                                                    type="button"
                                                    onClick={() => {
                                                        setShowCaseMenu(false);
                                                        navigate(`/cases/${caseItem.caseNumber}/cvr`);
                                                    }}
                                                    className="w-full text-left px-4 py-3 text-sm text-gray-700 hover:bg-emerald-50"
                                                >
                                                    <div className="font-semibold">{caseItem.caseNumber}</div>
                                                    <div className="text-xs text-gray-500">{caseItem.caseName}</div>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                    {!hasStarted ? (
                        <div className="border border-emerald-100 rounded-2xl bg-emerald-50/60 p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                            <div>
                                <p className="text-sm font-semibold text-emerald-700">Analysis ready to begin</p>
                                <p className="text-sm text-emerald-600 mt-1">
                                    The system will process the CVR audio through denoising, transcription, role identification, and
                                     emotion recognition.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleStartAnalysis}
                                disabled={!selectedCvrAttachment}
                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                            >
                                Start CVR Analysis
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    ) : (
                        <>
                            {progressBlock}

                            {!showResults && hasProgress && (
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={() => setShowResults(true)}
                                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                                    >
                                        Open analysis workspace
                                        <ChevronRight className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                    {denoiseStep.status === "error" && (
                        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                            {denoiseStep.error || "Denoise failed. Retry the step."}
                        </div>
                    )}
                </section>
            )}

            {workflowStage === "complete" && selectedCase && !showResults && (
                <section className="bg-white border border-gray-200 rounded-2xl p-10 text-center space-y-6">
                    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                        <CheckCircle2 className="w-10 h-10" />
                    </div>
                    <div className="space-y-2">
                        <p className="text-xs uppercase tracking-[0.3em] text-emerald-500">CVR pipeline</p>
                        <h2 className="text-3xl font-bold text-gray-900">Denoising Complete</h2>
                        <p className="text-sm text-gray-600 max-w-xl mx-auto">
                            The CVR denoise step for {selectedCase.id} is complete. Review the cleaned audio and prepare for transcription.
                        </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-3">
                        <button
                            type="button"
                            onClick={handleViewResults}
                            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                        >
                            View CVR results
                            <ChevronRight className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={handleChangeCase}
                            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-6 py-2 text-sm font-semibold text-gray-600 transition hover:border-emerald-300 hover:text-emerald-600"
                        >
                            Analyze another case
                        </button>
                    </div>
                </section>
            )}

            {selectedCase && showResults && (
                <section className="bg-white border border-gray-200 rounded-2xl">
                            <div className="border-b border-gray-200 px-6 pt-6 pb-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                            {isTranscriptionComplete ? "CVR results" : "CVR pipeline"} · {selectedCase.id}
                                        </p>
                                        <h3 className="text-xl font-semibold text-gray-900">
                                            {isTranscriptionComplete ? "Cockpit Voice Insights" : "CVR Analysis Workspace"}
                                        </h3>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <TabButton isActive={activeTab === "denoise"} onClick={() => goToStep("denoise")}>
                                            Audio Processing
                                        </TabButton>
                                        <TabButton isActive={activeTab === "channels"} onClick={() => goToStep("channels")}>
                                            Channel Separation
                                        </TabButton>
                                        <TabButton isActive={activeTab === "transcription"} onClick={() => goToStep("transcription")}>
                                            Transcription
                                        </TabButton>
                                        <TabButton isActive={activeTab === "events"} onClick={() => goToStep("events")}>
                                            Key Events
                                        </TabButton>
                                        <div className="flex flex-col items-center gap-1 rounded-xl border border-gray-100 px-2 py-1">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                                Analysis
                                            </span>
                                            <div className="flex flex-wrap gap-2">
                                                <TabButton
                                                    isActive={activeTab === "roles"}
                                                    onClick={() => goToStep("roles")}
                                                >
                                                    Role Identification
                                                </TabButton>
                                                <TabButton
                                                    isActive={activeTab === "emotion"}
                                                    onClick={() => goToStep("emotion")}
                                                >
                                                    Emotion Recognition
                                                </TabButton>
                                            </div>
                                        </div>
                                        <TabButton isActive={activeTab === "report"} onClick={() => goToStep("report")}>
                                            Report
                                        </TabButton>
                                    </div>
                                </div>
                            </div>
                            {activeTab === "denoise" && (
                                <div className="px-6 py-6 space-y-6">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-6">
                                        <div className="flex flex-wrap items-start justify-between gap-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Denoising</p>
                                                <p className="mt-2 text-sm text-gray-600">
                                                    Reduce background noise while preserving crew speech.
                                                </p>
                                            </div>
                                            <div className="text-xs text-emerald-700">
                                                {denoiseStep.status === "running" ? "Processing…" : "Ready"}
                                            </div>
                                        </div>
                                        {denoiseStep.status === "running" && (
                                            <div className="flex items-center gap-2 text-sm text-emerald-700">
                                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" />
                                                Denoising in progress…
                                            </div>
                                        )}
                                        <div className="flex flex-wrap items-end gap-4">
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="cvr-source" className="text-xs font-semibold text-gray-500">
                                                    Source audio
                                                </label>
                                                <select
                                                    id="cvr-source"
                                                    value={selectedCvrSourceKey}
                                                    onChange={handleCvrSourceChange}
                                                    disabled={denoiseStep.status === "running"}
                                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                >
                                                    {cvrSourceOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="denoise-method" className="text-xs font-semibold text-gray-500">
                                                    Denoise method
                                                </label>
                                                <select
                                                    id="denoise-method"
                                                    value={denoiseMethod}
                                                    onChange={(event) => setDenoiseMethod(event.target.value)}
                                                    disabled={denoiseStep.status === "running"}
                                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                >
                                                    <option value="facebook_denoiser">Facebook Denoiser (master64)</option>
                                                </select>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={runDenoise}
                                                disabled={!selectedCvrAttachment || denoiseStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                {denoiseStep.status === "running" && (
                                                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-white" />
                                                )}
                                                {denoiseStep.status === "completed"
                                                    ? "Rerun denoise"
                                                    : denoiseStep.status === "running"
                                                        ? "Running"
                                                        : "Run denoise"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => skipStep("denoise")}
                                                disabled={denoiseStep.status === "completed" || denoiseStep.status === "skipped" || denoiseStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200"
                                            >
                                                Skip step
                                            </button>
                                        </div>
                                        <div className="grid md:grid-cols-2 gap-6">
                                            {analysisAudioComparisons.map((track) => (
                                                <div key={track.id} className="border border-gray-200 rounded-2xl p-5 bg-white shadow-sm">
                                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                                        <div>
                                                            <h4 className="text-sm font-semibold text-gray-900">{track.title}</h4>
                                                            <p className="text-xs text-gray-500">{track.description}</p>
                                                        </div>
                                                        {track.src ? (
                                                            <a
                                                                href={track.src}
                                                                download={track.downloadName}
                                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-200 px-3 py-1 text-xs font-medium text-emerald-600 transition hover:bg-emerald-50"
                                                            >
                                                                <FileText className="w-4 h-4" /> WAV
                                                            </a>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs font-medium text-gray-400">
                                                                Pending
                                                            </span>
                                                        )}
                                                    </div>
                                                    {track.src ? (
                                                        <audio
                                                            controls
                                                            preload="none"
                                                            src={track.src}
                                                            className="mt-4 w-full rounded-xl border border-gray-200"
                                                        >
                                                            Your browser does not support the audio element.
                                                        </audio>
                                                    ) : (
                                                        <div className="mt-4 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-xs text-gray-400 text-center">
                                                            Audio will appear once processing completes.
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                        {denoisedAudioUrl ? (
                                            <div className="border border-emerald-100 bg-emerald-50/60 rounded-2xl p-5 text-sm text-emerald-700">
                                                Denoise output is ready for transcription and playback.
                                            </div>
                                        ) : null}
                                        {denoiseStep.status === "skipped" && (
                                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                                Denoising was skipped. You can rerun it at any time.
                                            </div>
                                        )}
                                        {denoiseStep.status === "error" && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {denoiseStep.error || "Denoising failed. Retry the step."}
                                            </div>
                                        )}
                                        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-4">
                                            <div className="flex flex-wrap items-center justify-between gap-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-gray-900">Denoise history</p>
                                                    <p className="text-xs text-gray-500">
                                                        Unsaved outputs are temporary until you save or delete them.
                                                    </p>
                                                </div>
                                                <span className="text-xs text-gray-400">
                                                    {denoiseHistory.length} output{denoiseHistory.length === 1 ? "" : "s"}
                                                </span>
                                            </div>
                                            {denoiseHistory.length === 0 ? (
                                                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
                                                    No denoise outputs yet.
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {denoiseHistory.map((entry) => {
                                                        const isCurrent = entry.outputId === currentDenoiseId;
                                                        const downloadUrl =
                                                            entry.downloadUrl ||
                                                            (caseNumber
                                                                ? `/api/cases/${caseNumber}/cvr/denoise/${encodeURIComponent(
                                                                    entry.outputId,
                                                                )}`
                                                                : "");
                                                        return (
                                                            <div
                                                                key={entry.outputId}
                                                                className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col gap-3"
                                                            >
                                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                                    <div>
                                                                        <p className="text-sm font-semibold text-gray-900">
                                                                            {entry.outputId}
                                                                        </p>
                                                                        <p className="text-xs text-gray-500">
                                                                            {entry.createdAt
                                                                                ? new Date(entry.createdAt).toLocaleString()
                                                                                : "Created recently"}
                                                                        </p>
                                                                    </div>
                                                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                                                        {isCurrent && (
                                                                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
                                                                                Latest
                                                                            </span>
                                                                        )}
                                                                        {entry.saved ? (
                                                                            <span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-600">
                                                                                Saved
                                                                            </span>
                                                                        ) : (
                                                                            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
                                                                                Unsaved
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <audio
                                                                    controls
                                                                    preload="none"
                                                                    src={downloadUrl}
                                                                    className="w-full rounded-xl border border-gray-200"
                                                                >
                                                                    Your browser does not support the audio element.
                                                                </audio>
                                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                                    <a
                                                                        href={downloadUrl}
                                                                        download={entry.outputId}
                                                                        className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 hover:border-emerald-200 hover:text-emerald-700"
                                                                    >
                                                                        Download
                                                                    </a>
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        {!entry.saved && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleSaveDenoiseOutput(entry.outputId)}
                                                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                                            >
                                                                                Save
                                                                            </button>
                                                                        )}
                                                                        {!isCurrent && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => confirmDeleteDenoiseOutput(entry)}
                                                                                className="inline-flex items-center gap-2 rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                                                            >
                                                                                Delete
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("channels")}
                                                disabled={denoiseStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "channels" && (
                                <div className="px-6 py-6 space-y-6">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-6">
                                        <div className="flex flex-wrap items-start justify-between gap-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Channel separation</p>
                                                <p className="mt-2 text-sm text-gray-600">
                                                    Isolate each speaker's audio using diarization, so you can listen to
                                                    individual voices before transcription.
                                                </p>
                                            </div>
                                            <div className="text-xs text-emerald-700">
                                                {channelsStep.status === "running" ? "Processing…" : "Ready"}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-end gap-4">
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="channels-source" className="text-xs font-semibold text-gray-500">
                                                    Source audio
                                                </label>
                                                <select
                                                    id="channels-source"
                                                    value={channelSeparationSourceKey}
                                                    onChange={(event) => setChannelSeparationSourceKey(event.target.value)}
                                                    disabled={channelsStep.status === "running"}
                                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                >
                                                    {cvrSourceOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={runChannelSeparation}
                                                disabled={channelsStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                {channelsStep.status === "running"
                                                    ? "Running"
                                                    : channelsStep.status === "completed"
                                                    ? "Rerun separation"
                                                    : "Run channel separation"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => skipStep("channels")}
                                                disabled={channelsStep.status === "running" || channelsStep.status === "completed"}
                                                className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200"
                                            >
                                                Skip step
                                            </button>
                                        </div>
                                        {channelsStep.status === "error" && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {channelsStep.error || "Channel separation failed."}
                                            </div>
                                        )}
                                        {channelsStep.status === "skipped" && (
                                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                                Channel separation was skipped.
                                            </div>
                                        )}
                                        {channelsStep.status === "completed" && (
                                            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                                                <p className="text-sm font-semibold text-gray-900">
                                                    Separated speakers ({channelsStep.output?.channels?.length || 0})
                                                </p>
                                                {(channelsStep.output?.channels || []).map((channel) => (
                                                    <div
                                                        key={channel.speaker}
                                                        className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 space-y-2"
                                                    >
                                                        <div className="flex items-center justify-between text-sm">
                                                            <span className="font-semibold text-gray-800">{channel.speaker}</span>
                                                            <span className="text-xs text-gray-500">
                                                                {channel.duration ? `${channel.duration.toFixed(1)}s` : ""}
                                                            </span>
                                                        </div>
                                                        {channel.downloadUrl && (
                                                            <audio controls preload="none" src={channel.downloadUrl} className="w-full" />
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("denoise")}
                                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                                            >
                                                Back
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => goToStep("transcription")}
                                                disabled={channelsStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "transcription" && (
                                <div className="px-6 py-6 space-y-6">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-6">
                                        <div className="flex flex-wrap items-start justify-between gap-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Transcription</p>
                                                <p className="mt-2 text-sm text-gray-600">
                                                    Send the selected audio to the model and optionally enable diarization to label
                                                    speaker turns.
                                                </p>
                                            </div>
                                        </div>
                                        {transcriptionStep.status === "running" && (
                                            <div className="flex items-center gap-2 text-sm text-emerald-700">
                                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" />
                                                Transcription in progress…
                                            </div>
                                        )}
                                        <div className="flex flex-wrap items-center gap-4">
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="transcription-model" className="text-xs font-semibold text-gray-500">
                                                    Transcription model
                                                </label>
                                                <select
                                                    id="transcription-model"
                                                    value={transcriptionModel}
                                                    onChange={(event) => setTranscriptionModel(event.target.value)}
                                                    className="w-48 rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                >
                                                <option value="openai/whisper-large-v3">Whisper Large (v3)</option>
                                                <option value="openai/whisper-medium">Whisper Medium</option>
                                                <option value="openai/whisper-small">Whisper Small</option>
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="transcription-source" className="text-xs font-semibold text-gray-500">
                                                    Source audio
                                                </label>
                                                <select
                                                    id="transcription-source"
                                                    value={transcriptionSource}
                                                    onChange={(event) => setTranscriptionSource(event.target.value)}
                                                    className="w-40 rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                >
                                                    <option value="auto">Auto (latest available)</option>
                                                    <option value="original">Original CVR audio</option>
                                                    <option value="denoised" disabled={!denoiseReady}>
                                                        Denoised output
                                                    </option>
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="transcription-channel" className="text-xs font-semibold text-gray-500">
                                                    Channel selection
                                                </label>
                                                <select
                                                    id="transcription-channel"
                                                    value={transcriptionCvrSourceKey}
                                                    onChange={handleTranscriptionSourceKeyChange}
                                                    disabled={!canSelectTranscriptionChannel || transcriptionStep.status === "running"}
                                                    className="w-40 rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:bg-gray-100"
                                                >
                                                    {cvrSourceOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <label className="flex items-center gap-2 text-sm text-gray-600">
                                                <input
                                                    type="checkbox"
                                                    checked={enableDiarization}
                                                    onChange={(event) => setEnableDiarization(event.target.checked)}
                                                    className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-200"
                                                />
                                                Enable speaker diarization
                                            </label>
                                            <button
                                                type="button"
                                                onClick={runTranscription}
                                                disabled={
                                                    transcriptionStep.status === "running" ||
                                                    (transcriptionSource === "denoised" && !denoiseReady)
                                                }
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                {transcriptionStep.status === "running" && (
                                                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-white" />
                                                )}
                                                {transcriptionStep.status === "completed"
                                                    ? "Rerun transcription"
                                                    : transcriptionStep.status === "running"
                                                        ? "Running"
                                                        : "Run transcription"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setTranscriptionSkipPrompt(true)}
                                                disabled={
                                                    transcriptionStep.status === "running" ||
                                                    transcriptionStep.status === "completed" ||
                                                    transcriptionStep.status === "skipped"
                                                }
                                                className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200"
                                            >
                                                Skip step
                                            </button>
                                        </div>
                                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                            Transcription is required for role identification and final insights. You can skip it
                                            for now, but those outputs will remain locked until transcription is complete.
                                        </div>
                                        {!denoiseReady && (
                                            <p className="text-xs text-amber-600">
                                                Complete or skip denoising before running transcription.
                                            </p>
                                        )}
                                        {!canSelectTranscriptionChannel && (
                                            <p className="text-xs text-gray-500">
                                                Channel selection applies to original audio. Switch source to Original to select a channel.
                                            </p>
                                        )}
                                        <p className="text-xs text-gray-500">
                                            Transcription source: {denoiseStep.status === "completed"
                                                ? "denoised audio"
                                                : "original audio"}
                                        </p>
                                        {isTranscriptionComplete && (
                                            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-5 text-sm text-emerald-700">
                                                {transcriptionStep.output?.summary || "Transcription completed."}
                                                {transcriptionStep.output?.diarizationError && (
                                                    <p className="mt-2 text-xs text-amber-700">
                                                        Diarization was skipped due to an error:{" "}
                                                        {transcriptionStep.output.diarizationError}
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                        {transcriptionStep.status === "error" && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {transcriptionStep.error || "Transcription failed. Retry the step."}
                                            </div>
                                        )}
                                        {isTranscriptionComplete &&
                                            (transcriptionStep.output?.transcriptText ||
                                                transcriptionStep.output?.diarizedTranscript) && (
                                            <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-4">
                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                    <div>
                                                        <p className="text-sm font-semibold text-gray-900">Generated transcript</p>
                                                        <p className="text-xs text-gray-500">
                                                            Review the draft transcript and export for review.
                                                        </p>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleExportTranscript("pdf")}
                                                            className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 hover:border-emerald-200 hover:text-emerald-700"
                                                        >
                                                            Export PDF
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleExportTranscript("word")}
                                                            className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 hover:border-emerald-200 hover:text-emerald-700"
                                                        >
                                                            Export Word
                                                        </button>
                                                    </div>
                                                </div>
                                                {transcriptionStep.output?.diarizedTranscript?.length ? (
                                                    <div className="space-y-3">
                                                        {transcriptionStep.output.diarizedTranscript.map((segment, index) => (
                                                            <div
                                                                key={`${segment.speaker}-${segment.start}-${index}`}
                                                                className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700"
                                                            >
                                                                <div className="text-xs font-semibold text-emerald-600">
                                                                    {segment.speaker}
                                                                    {segment.start != null && segment.end != null && (
                                                                        <span className="ml-2 text-gray-400">
                                                                            {segment.start.toFixed(1)}s – {segment.end.toFixed(1)}s
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <p className="mt-2 whitespace-pre-wrap leading-6">{segment.text}</p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : transcriptionStep.output?.diarization?.length ? (
                                                    <div className="space-y-3">
                                                        <p className="text-xs text-gray-500">
                                                            Speaker labels detected, but no word-level alignment was available for the selected
                                                            model.
                                                        </p>
                                                        {transcriptionStep.output.diarization.map((segment, index) => (
                                                            <div
                                                                key={`${segment.speaker}-${segment.start}-${index}`}
                                                                className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700"
                                                            >
                                                                <div className="text-xs font-semibold text-emerald-600">
                                                                    {segment.speaker}
                                                                    {segment.start != null && segment.end != null && (
                                                                        <span className="ml-2 text-gray-400">
                                                                            {segment.start.toFixed(1)}s – {segment.end.toFixed(1)}s
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <p className="mt-2 text-sm text-gray-500">
                                                                    No aligned transcript available for this segment.
                                                                </p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm text-gray-700 whitespace-pre-wrap leading-6">
                                                        {formattedTranscript || transcriptionStep.output?.transcriptText}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("channels")}
                                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                                            >
                                                Back
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => goToStep("events")}
                                                disabled={transcriptionStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "roles" && (
                                <div className="px-6 py-6 space-y-6">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                                        <p className="text-sm font-semibold text-gray-900">Role identification</p>
                                        <p className="mt-2 text-sm text-gray-600">
                                            Map diarized speakers to ATC or PILOT roles using the role identification service.
                                        </p>
                                        <div className="mt-2 text-xs text-emerald-700">
                                            {rolesStep.status === "running"
                                                ? "Role identification in progress…"
                                                : rolesStep.status === "completed"
                                                ? "Completed"
                                                : "Ready"}
                                        </div>
                                        {isTranscriptionComplete && !hasDiarizedTranscript && (
                                            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                                This transcript doesn't include diarized speaker segments, so roles can't be
                                                mapped. Go back to Transcription, enable{" "}
                                                <span className="font-semibold">"Enable speaker diarization"</span>, and re-run
                                                it before continuing.{" "}
                                                <button
                                                    type="button"
                                                    onClick={() => goToStep("transcription")}
                                                    className="font-semibold underline"
                                                >
                                                    Go to Transcription
                                                </button>
                                            </div>
                                        )}
                                        <div className="mt-4 grid sm:grid-cols-2 gap-4 text-sm text-gray-500">
                                            <div className="rounded-xl border border-dashed border-gray-200 p-4">
                                                Speaker A → Captain
                                            </div>
                                            <div className="rounded-xl border border-dashed border-gray-200 p-4">
                                                Speaker B → First Officer
                                            </div>
                                            <div className="rounded-xl border border-dashed border-gray-200 p-4">
                                                Speaker C → Observer
                                            </div>
                                            <div className="rounded-xl border border-dashed border-gray-200 p-4">
                                                Speaker D → Cabin/ATC
                                            </div>
                                        </div>
                                        <div className="mt-4 flex flex-wrap items-center gap-3">
                                            <button
                                                type="button"
                                                onClick={runRoleIdentification}
                                                disabled={rolesStep.status === "running" || !isRoleIdentificationReady}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                {rolesStep.status === "completed" ? "Rerun role identification" : "Run role identification"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => skipStep("roles")}
                                                disabled={rolesStep.status === "completed" || rolesStep.status === "skipped" || !isTranscriptionComplete}
                                                className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200"
                                            >
                                                Skip step
                                            </button>
                                        </div>
                                        {rolesStep.status === "skipped" && (
                                            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                                Role identification was skipped.
                                            </div>
                                        )}
                                        {rolesStep.status === "completed" && (
                                            <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-700">
                                                {rolesStep.output?.summary || "Role identification completed."}
                                            </div>
                                        )}
                                        {rolesStep.output?.speakerRoles &&
                                            Object.keys(rolesStep.output.speakerRoles).length > 0 && (
                                                <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                                                    <div>
                                                        <p className="text-sm font-semibold text-gray-900">Role assignments</p>
                                                        <p className="text-xs text-gray-500">
                                                            Speaker labels mapped to ATC or PILOT.
                                                        </p>
                                                    </div>
                                                    <div className="grid gap-3 sm:grid-cols-2">
                                                        {Object.entries(rolesStep.output.speakerRoles).map(
                                                            ([speaker, role]) => (
                                                                <div
                                                                    key={speaker}
                                                                    className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700"
                                                                >
                                                                    <span className="text-xs font-semibold text-emerald-600">
                                                                        {speaker}
                                                                    </span>
                                                                    <div className="mt-1 text-sm font-semibold text-gray-900">
                                                                        {role}
                                                                    </div>
                                                                </div>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        {rolesStep.output?.utterances?.length > 0 && (
                                            <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-gray-900">Role-labeled transcript</p>
                                                    <p className="text-xs text-gray-500">
                                                        Review utterances with assigned roles.
                                                    </p>
                                                </div>
                                                <div className="space-y-3">
                                                    {rolesStep.output.utterances.map((utt, index) => (
                                                        <div
                                                            key={`${utt.speaker}-${utt.start}-${index}`}
                                                            className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700"
                                                        >
                                                            <div className="text-xs font-semibold text-emerald-600">
                                                                {utt.role || "PILOT"}
                                                                <span className="ml-2 text-gray-400">
                                                                    {utt.speaker || "Speaker"}
                                                                </span>
                                                                {utt.start != null && utt.end != null && (
                                                                    <span className="ml-2 text-gray-400">
                                                                        {utt.start.toFixed(1)}s – {utt.end.toFixed(1)}s
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="mt-2 whitespace-pre-wrap leading-6">{utt.text}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("events")}
                                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                                            >
                                                Back
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => goToStep("emotion")}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition"
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "events" && (
                                <div className="px-6 py-6 space-y-6">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-6">
                                        <div className="flex flex-wrap items-start justify-between gap-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Event detection</p>
                                                <p className="mt-2 text-sm text-gray-600">
                                                    Scan original CVR audio for alarms, impacts, and anomalous tones.
                                                </p>
                                            </div>
                                            <div className="text-xs text-emerald-700">
                                                {eventDetection.status === "running" ? "Processing…" : "Ready"}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-end gap-4">
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="event-source" className="text-xs font-semibold text-gray-500">
                                                    Source audio
                                                </label>
                                                <select
                                                    id="event-source"
                                                    value={eventDetectionSourceKey}
                                                    onChange={handleEventSourceChange}
                                                    disabled={eventDetection.status === "running"}
                                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                >
                                                    {cvrSourceOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="event-threshold" className="text-xs font-semibold text-gray-500">
                                                    Confidence threshold
                                                </label>
                                                <input
                                                    id="event-threshold"
                                                    type="number"
                                                    step="0.05"
                                                    min="0"
                                                    max="1"
                                                    value={eventDetectionConfig.threshold}
                                                    onChange={(event) =>
                                                        setEventDetectionConfig((prev) => ({
                                                            ...prev,
                                                            threshold: Number(event.target.value || 0),
                                                        }))
                                                    }
                                                    className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                                                />
                                            </div>
                                            <button
                                                type="button"
                                                onClick={runEventDetection}
                                                disabled={eventDetection.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                {eventDetection.status === "running"
                                                    ? "Running"
                                                    : eventDetection.status === "completed"
                                                    ? "Rerun detection"
                                                    : "Run detection"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => skipStep("events")}
                                                disabled={eventDetection.status === "running" || eventDetection.status === "completed"}
                                                className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200"
                                            >
                                                Skip step
                                            </button>
                                        </div>
                                        {eventDetection.status === "error" && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {eventDetection.error || "Event detection failed."}
                                            </div>
                                        )}
                                        {eventDetection.status === "completed" && (
                                            <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-5 text-sm text-emerald-700">
                                                Detected {eventDetectionEvents.length} event
                                                {eventDetectionEvents.length === 1 ? "" : "s"}.
                                            </div>
                                        )}
                                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Detected events</p>
                                                <p className="text-xs text-gray-500">
                                                    Alarm and impact markers detected in the original audio.
                                                </p>
                                            </div>
                                            {eventDetectionEvents.length === 0 ? (
                                                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
                                                    No events detected yet.
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {eventDetectionEvents.map((evt, index) => (
                                                        <div
                                                            key={`${evt.event_type}-${evt.timestamp}-${index}`}
                                                            className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700"
                                                        >
                                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                                <span className="text-xs font-semibold text-emerald-600">
                                                                    {evt.event_type}
                                                                </span>
                                                                <span className="text-xs text-gray-400">
                                                                    {evt.timestamp.toFixed(2)}s · {evt.duration.toFixed(2)}s ·{" "}
                                                                    {(evt.confidence * 100).toFixed(0)}%
                                                                </span>
                                                            </div>
                                                            {evt.frequency_peak && (
                                                                <p className="mt-2 text-xs text-gray-500">
                                                                    Peak frequency: {evt.frequency_peak.toFixed(0)} Hz
                                                                </p>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">Uploaded CVR audio</p>
                                                <p className="text-xs text-gray-500">
                                                    Review available cockpit recordings for this case.
                                                </p>
                                            </div>
                                            {cvrAttachmentList.length === 0 ? (
                                                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
                                                    No CVR audio uploads found for this case.
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {cvrAttachmentList.map((attachment) => {
                                                        const key = attachment.storage?.objectKey;
                                                        const url = key ? eventAudioUrls[key] : "";
                                                        return (
                                                            <div
                                                                key={attachment.id || key}
                                                                className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3"
                                                            >
                                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                                    <div>
                                                                        <p className="text-sm font-semibold text-gray-900">
                                                                            {attachment.name || "CVR audio"}
                                                                        </p>
                                                                        <p className="text-xs text-gray-500">
                                                                            {attachment.channelLabel || attachment.channel || "Mix"}
                                                                        </p>
                                                                    </div>
                                                                    {!url ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => loadAttachmentAudio(attachment)}
                                                                            className="inline-flex items-center gap-2 rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                                        >
                                                                            Load audio
                                                                        </button>
                                                                    ) : (
                                                                        <a
                                                                            href={url}
                                                                            download={attachment.name || "cvr-audio.wav"}
                                                                            className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 hover:border-emerald-200 hover:text-emerald-700"
                                                                        >
                                                                            Download
                                                                        </a>
                                                                    )}
                                                                </div>
                                                                {url && (
                                                                    <audio
                                                                        controls
                                                                        preload="none"
                                                                        src={url}
                                                                        className="mt-3 w-full rounded-xl border border-gray-200"
                                                                    />
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("transcription")}
                                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                                            >
                                                Back
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => goToStep("roles")}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition"
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "emotion" && (
                                <div className="px-6 py-6 space-y-4">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-6">
                                        <div>
                                            <p className="text-sm font-semibold text-gray-900">Emotion recognition</p>
                                            <p className="mt-2 text-sm text-gray-600">
                                                Run emotion detection on the CVR audio to estimate the dominant cockpit affect.
                                            </p>
                                            <div className="mt-2 text-xs text-emerald-700">
                                                {emotionStep.status === "running"
                                                    ? "Emotion recognition in progress…"
                                                    : emotionStep.status === "completed"
                                                    ? "Completed"
                                                    : "Ready"}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-3">
                                            <button
                                                type="button"
                                                onClick={runEmotionRecognition}
                                                disabled={emotionStep.status === "running"}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:bg-emerald-200"
                                            >
                                                {emotionStep.status === "completed" ? "Rerun emotion recognition" : "Run emotion recognition"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => skipStep("emotion")}
                                                disabled={emotionStep.status === "completed" || emotionStep.status === "skipped"}
                                                className="inline-flex items-center gap-2 rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700 transition disabled:cursor-not-allowed disabled:text-gray-300 disabled:border-gray-200"
                                            >
                                                Skip step
                                            </button>
                                        </div>
                                        {emotionStep.status === "skipped" && (
                                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                                Emotion recognition was skipped.
                                            </div>
                                        )}
                                        {emotionStep.status === "completed" && (
                                            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                                                    Emotion result
                                                </p>
                                                <p className="mt-2 text-sm font-semibold text-slate-800">
                                                    {emotionStep.output?.summary || "Emotion recognition completed."}
                                                </p>
                                            </div>
                                        )}
                                        {emotionStep.status === "error" && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {emotionStep.error || "Emotion recognition failed."}
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("roles")}
                                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                                            >
                                                Back
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => goToStep("report")}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition"
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "report" && (
                                <div className="px-6 py-6 space-y-6">
                                    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-6">
                                        <div>
                                            <p className="text-sm font-semibold text-gray-900">CVR analysis report</p>
                                            <p className="mt-2 text-sm text-gray-600">
                                                Review what's been produced across the pipeline, then generate the final
                                                cockpit voice analysis report.
                                            </p>
                                        </div>

                                        <div className="grid sm:grid-cols-2 gap-4">
                                            {analysisStages.map((stage) => {
                                                const stepData = getStepData(stage.key);
                                                const stepStatus = stepData.status || "pending";
                                                const badgeClass =
                                                    stepStatus === "completed"
                                                        ? "bg-emerald-100 text-emerald-700"
                                                        : stepStatus === "skipped"
                                                        ? "bg-amber-100 text-amber-700"
                                                        : stepStatus === "error"
                                                        ? "bg-rose-100 text-rose-700"
                                                        : stepStatus === "running"
                                                        ? "bg-sky-100 text-sky-700"
                                                        : "bg-gray-100 text-gray-500";
                                                return (
                                                    <div
                                                        key={stage.key}
                                                        className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3"
                                                    >
                                                        <span className="text-sm font-semibold text-gray-800">{stage.label}</span>
                                                        <span
                                                            className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${badgeClass}`}
                                                        >
                                                            {stepStatus}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                                            <p className="text-sm font-semibold text-gray-900">Key outputs</p>
                                            <div className="space-y-1">
                                                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                                    Transcript
                                                </p>
                                                <p className="text-sm text-gray-700">
                                                    {transcriptionStep.output?.transcriptText
                                                        ? `${transcriptionStep.output.transcriptText.slice(0, 240)}${
                                                              transcriptionStep.output.transcriptText.length > 240 ? "…" : ""
                                                          }`
                                                        : "Transcription not completed yet."}
                                                </p>
                                            </div>
                                            <div className="space-y-1">
                                                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                                    Key events
                                                </p>
                                                <p className="text-sm text-gray-700">
                                                    {eventDetectionEvents.length > 0
                                                        ? `${eventDetectionEvents.length} event${
                                                              eventDetectionEvents.length === 1 ? "" : "s"
                                                          } detected.`
                                                        : "No events detected yet."}
                                                </p>
                                            </div>
                                            <div className="space-y-1">
                                                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                                    Role identification
                                                </p>
                                                <p className="text-sm text-gray-700">
                                                    {rolesStep.output?.summary || "Role identification not completed yet."}
                                                </p>
                                            </div>
                                            <div className="space-y-1">
                                                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                                    Emotion recognition
                                                </p>
                                                <p className="text-sm text-gray-700">
                                                    {emotionStep.output?.summary || "Emotion recognition not completed yet."}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                                            <button
                                                type="button"
                                                onClick={() => goToStep("emotion")}
                                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                                            >
                                                Back
                                            </button>
                                            <button
                                                type="button"
                                                onClick={generateFinalInsights}
                                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition"
                                            >
                                                Generate Report
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}
        </div>
    );
}
