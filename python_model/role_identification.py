#!/usr/bin/env python3
"""
LLM-based Role Identification for CVR Transcripts using Ollama
Uses local Llama model to classify speakers as ATC or PILOT.
"""

import argparse
import json
import os
from typing import Dict, List

import requests


class OllamaRoleIdentifier:
    """Identifies speaker roles using local Ollama LLM"""

    def __init__(self, model: str = "llama3.2:3b", ollama_url: str = "http://localhost:11434"):
        self.model = model
        self.ollama_url = ollama_url
        self.ollama_available = False

        try:
            response = requests.get(f"{ollama_url}/api/tags", timeout=10)
            self.ollama_available = response.status_code == 200
        except Exception as exc:
            print(
                f"Warning: Cannot connect to Ollama at {ollama_url} ({exc}). "
                f"Falling back to keyword-based role classification.",
                flush=True,
            )

    def identify_roles(self, utterances: List[Dict]) -> Dict[str, str]:
        speaker_utterances = {}
        for utt in utterances:
            speaker = utt["speaker"]
            if speaker not in speaker_utterances:
                speaker_utterances[speaker] = []
            speaker_utterances[speaker].append(utt["text"])

        if not self.ollama_available:
            return self._fallback_classification(speaker_utterances)

        conversation_text = self._format_conversation(speaker_utterances)
        prompt = f"""You are an aviation expert analyzing cockpit voice recorder (CVR) transcripts.

Identify the role of each speaker. Roles are:
- ATC: Air Traffic Control (gives clearances, instructions, traffic/weather info)
- PILOT: Cockpit crew (reads back clearances, makes requests, discusses aircraft systems)

Aviation communication rules:
- ATC says: "cleared to land", "turn left heading", "contact departure", "maintain altitude", "wind 190 at 25"
- PILOT says: aircraft callsign (Alaska 123), "roger", "wilco", declares emergencies, discusses cockpit operations

Conversation:
{conversation_text}

Respond ONLY with JSON mapping each speaker to ATC or PILOT:
{{"SPEAKER_00": "ATC", "SPEAKER_01": "PILOT"}}

JSON only, no explanation:"""

        response_text = ""
        try:
            response = requests.post(
                f"{self.ollama_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1},
                },
                timeout=60,
            )

            if response.status_code != 200:
                raise RuntimeError(f"Ollama API error: {response.status_code}")

            response_text = response.json()["response"].strip()
            if "```" in response_text:
                parts = response_text.split("```")
                for part in parts:
                    part = part.strip()
                    if part.startswith("json"):
                        part = part[4:].strip()
                    if part.startswith("{"):
                        response_text = part
                        break

            start = response_text.find("{")
            end = response_text.rfind("}") + 1
            if start != -1 and end != 0:
                response_text = response_text[start:end]

            speaker_roles = json.loads(response_text)

            for speaker, role in speaker_roles.items():
                if role not in ["ATC", "PILOT"]:
                    speaker_roles[speaker] = "PILOT"

            return speaker_roles
        except Exception:
            return self._fallback_classification(speaker_utterances)

    def _fallback_classification(self, speaker_utterances: Dict[str, List[str]]) -> Dict[str, str]:
        roles = {}
        for speaker, texts in speaker_utterances.items():
            all_text = " ".join(texts).lower()
            if "cleared" in all_text or "contact" in all_text or "turn left" in all_text or "turn right" in all_text:
                roles[speaker] = "ATC"
            else:
                roles[speaker] = "PILOT"
        return roles

    def _format_conversation(self, speaker_utterances: Dict[str, List[str]]) -> str:
        lines = []
        for speaker, texts in speaker_utterances.items():
            lines.append(f"\n{speaker}:")
            for idx, text in enumerate(texts[:5], 1):
                lines.append(f"  {idx}. {text}")
            if len(texts) > 5:
                lines.append(f"  ... ({len(texts) - 5} more)")
        return "\n".join(lines)

    def classify(self, utterances: List[Dict]) -> Dict:
        speaker_roles = self.identify_roles(utterances)
        for utt in utterances:
            utt["role"] = speaker_roles.get(utt["speaker"], "PILOT")
        return {
            "speaker_roles": speaker_roles,
            "utterances": utterances,
        }


def main():
    parser = argparse.ArgumentParser(description="Add role labels to diarized transcripts using Ollama")
    parser.add_argument("--input", required=True, help="Input JSON with diarized utterances")
    parser.add_argument("--output", required=True, help="Output JSON for role-labeled results")
    parser.add_argument("--model", default=os.getenv("OLLAMA_MODEL", "llama3.2:3b"))
    parser.add_argument("--ollama-url", default=os.getenv("OLLAMA_URL", "http://localhost:11434"))
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    utterances = payload.get("utterances", [])
    if not utterances:
        raise RuntimeError("Input JSON does not include diarized utterances.")

    identifier = OllamaRoleIdentifier(model=args.model, ollama_url=args.ollama_url)
    result = identifier.classify(utterances)

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)


if __name__ == "__main__":
    main()
