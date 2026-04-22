import request from "./client";

export const fetchNotes = (caseNumber, { module } = {}) => {
  const query = module ? `?module=${encodeURIComponent(module)}` : "";
  return request(`/cases/${caseNumber}/notes${query}`);
};

export const createNote = (caseNumber, payload) =>
  request(`/cases/${caseNumber}/notes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateNote = (caseNumber, noteId, payload) =>
  request(`/cases/${caseNumber}/notes/${noteId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteNote = (caseNumber, noteId) =>
  request(`/cases/${caseNumber}/notes/${noteId}`, {
    method: "DELETE",
  });
