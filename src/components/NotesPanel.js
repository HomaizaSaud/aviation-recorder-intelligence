import React, { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { createNote, deleteNote, fetchNotes, updateNote } from "../api/notes";
import { useAuth } from "../hooks/useAuth";

const formatAuthor = (author = {}) => {
  const name = `${author.firstName || ""} ${author.lastName || ""}`.trim();
  if (name) {
    return name;
  }
  return author.email || "Unknown";
};

const formatTimestamp = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
};

const canManageNote = (noteAuthor, user) => {
  if (!noteAuthor || !user) {
    return false;
  }
  if (noteAuthor.id && user.id) {
    return noteAuthor.id === user.id;
  }
  if (noteAuthor.email && user.email) {
    return noteAuthor.email === user.email;
  }
  return false;
};

const NOTE_MAX_LENGTH = 10000;

const formatRunId = (value) => {
  if (!value) {
    return "";
  }
  const raw = String(value);
  const shortId = raw.slice(0, 8);
  return shortId ? `Run ID: ${shortId}${raw.length > 8 ? "…" : ""}` : "";
};

const resolveNoteErrorMessage = (error, fallback) => {
  if (error?.status === 413) {
    return "Note too long (max 10,000 characters).";
  }
  return fallback;
};

const resetRequestError = (setError, setLastRequestFailed) => {
  setError("");
  setLastRequestFailed(false);
};

export default function NotesPanel({
  caseNumber,
  module,
  relatedRunId = null,
  emptyMessage = "No notes saved yet.",
}) {
  const { user } = useAuth();
  const [notes, setNotes] = useState([]);
  const [noteInput, setNoteInput] = useState("");
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [lastRequestFailed, setLastRequestFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editContent, setEditContent] = useState("");

  const trimmedInput = noteInput.trim();
  const canAdd = Boolean(trimmedInput) && Boolean(caseNumber) && !isSaving;
  const runIdLabel = relatedRunId ? formatRunId(relatedRunId) : "";
  const noteLengthLabel = `${noteInput.length}/${NOTE_MAX_LENGTH}`;

  const loadNotes = async ({ withLoader = false } = {}) => {
    if (!caseNumber || !module) {
      setNotes([]);
      return;
    }

    if (withLoader) {
      setIsLoading(true);
    }

    try {
      const data = await fetchNotes(caseNumber, { module });
      setNotes(Array.isArray(data) ? data : []);
      resetRequestError(setError, setLastRequestFailed);
    } catch (err) {
      console.error(
        `Notes GET failed (${err?.status || "unknown"}) for /cases/${caseNumber}/notes: ${err?.message || "Request failed"}`
      );
      setError(resolveNoteErrorMessage(err, "Unable to load notes."));
      setLastRequestFailed(true);
    } finally {
      if (withLoader) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      if (!isMounted) {
        return;
      }
      await loadNotes({ withLoader: true });
    };

    load();

    return () => {
      isMounted = false;
    };
  }, [caseNumber, module]);

  const handleAddNote = async () => {
    if (!canAdd) {
      return;
    }
    if (trimmedInput.length > NOTE_MAX_LENGTH) {
      setValidationError("Note too long (max 10,000 characters).");
      return;
    }
    setIsSaving(true);
    resetRequestError(setError, setLastRequestFailed);
    setValidationError("");
    try {
      await createNote(caseNumber, {
        module,
        relatedRunId,
        content: trimmedInput,
      });
      setNoteInput("");
      await loadNotes();
      resetRequestError(setError, setLastRequestFailed);
    } catch (err) {
      console.error(
        `Notes POST failed (${err?.status || "unknown"}) for /cases/${caseNumber}/notes`
      );
      setError(resolveNoteErrorMessage(err, "Unable to save note."));
      setLastRequestFailed(true);
    } finally {
      setIsSaving(false);
    }
  };

  const beginEdit = (note) => {
    setEditingNoteId(note.id);
    setEditContent(note.content);
  };

  const cancelEdit = () => {
    setEditingNoteId(null);
    setEditContent("");
  };

  const handleSaveEdit = async (noteId) => {
    const trimmed = editContent.trim();
    if (!trimmed) {
      setValidationError("Note content cannot be empty.");
      return;
    }
    if (trimmed.length > NOTE_MAX_LENGTH) {
      setValidationError("Note too long (max 10,000 characters).");
      return;
    }
    setIsSaving(true);
    resetRequestError(setError, setLastRequestFailed);
    setValidationError("");
    try {
      const updated = await updateNote(caseNumber, noteId, { content: trimmed });
      setNotes((prev) => prev.map((note) => (note.id === noteId ? updated : note)));
      cancelEdit();
      resetRequestError(setError, setLastRequestFailed);
    } catch (err) {
      setError(resolveNoteErrorMessage(err, "Unable to update note."));
      setLastRequestFailed(true);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (noteId) => {
    const confirmed = window.confirm("Delete this note? This action cannot be undone.");
    if (!confirmed) {
      return;
    }
    setIsSaving(true);
    resetRequestError(setError, setLastRequestFailed);
    setValidationError("");
    try {
      await deleteNote(caseNumber, noteId);
      setNotes((prev) => prev.filter((note) => note.id !== noteId));
      resetRequestError(setError, setLastRequestFailed);
    } catch (err) {
      setError(resolveNoteErrorMessage(err, "Unable to delete note."));
      setLastRequestFailed(true);
    } finally {
      setIsSaving(false);
    }
  };

  const noteList = useMemo(
    () => (Array.isArray(notes) ? notes : []),
    [notes]
  );

  return (
    <div className="mt-4 space-y-4">
      {lastRequestFailed && error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
        >
          <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-rose-600">
            !
          </span>
          <span>{error}</span>
        </div>
      )}
      <div className="space-y-2">
        <textarea
          rows={4}
          className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 focus:border-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-100"
          placeholder="Add follow-up actions or observations..."
          value={noteInput}
          onChange={(event) => {
            setNoteInput(event.target.value);
            resetRequestError(setError, setLastRequestFailed);
            setValidationError("");
          }}
          maxLength={NOTE_MAX_LENGTH}
        />
        {validationError && (
          <p className="text-xs text-rose-600">{validationError}</p>
        )}
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {relatedRunId
              ? `Linked to latest analysis run${runIdLabel ? ` (${runIdLabel})` : ""}.`
              : "Not linked to a run."}
          </p>
          <p className="text-xs text-gray-400">{noteLengthLabel}</p>
          <button
            type="button"
            onClick={handleAddNote}
            disabled={!canAdd}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-200"
          >
            <Check className="h-4 w-4" />
            Add note
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">Saved notes</h3>
        {isLoading ? (
          <p className="text-sm text-gray-500">Loading notes…</p>
        ) : noteList.length === 0 ? (
          <p className="text-sm text-gray-500">{emptyMessage}</p>
        ) : (
          <ul className="space-y-3">
            {noteList.map((note) => {
              const isAuthor = canManageNote(note.author, user);
              const isEditing = editingNoteId === note.id;
              return (
                <li
                  key={note.id}
                  className="rounded-2xl border border-gray-100 bg-white px-4 py-3 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">
                        {formatAuthor(note.author)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatTimestamp(note.createdAt)}
                        {note.relatedRunId
                          ? ` · Latest analysis run (${formatRunId(note.relatedRunId)})`
                          : ""}
                      </p>
                    </div>
                    {isAuthor && (
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(note.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                              disabled={isSaving}
                            >
                              <Check className="h-3 w-3" />
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                            >
                              <X className="h-3 w-3" />
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => beginEdit(note)}
                              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                            >
                              <Pencil className="h-3 w-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(note.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              <Trash2 className="h-3 w-3" />
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {isEditing ? (
                    <textarea
                      rows={3}
                      className="mt-3 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                      value={editContent}
                      onChange={(event) => {
                        setEditContent(event.target.value);
                        resetRequestError(setError, setLastRequestFailed);
                        setValidationError("");
                      }}
                      maxLength={NOTE_MAX_LENGTH}
                    />
                  ) : (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700">
                      {note.content}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
