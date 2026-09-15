"""Replaceable LLM provider boundary.

DataSynx uses LLMs for *perception* only (reading fields out of messy text).
All arithmetic and measurements stay in the deterministic engines. When no
provider is configured, callers fall back to rule-based extraction rather than
inventing values.
"""

from __future__ import annotations

import json
import os
from typing import Any, Protocol

import httpx


class LLMProvider(Protocol):
    name: str

    def extract(self, instruction: str, text: str, schema: dict[str, Any]) -> dict[str, Any] | None: ...


class OpenAICompatibleProvider:
    """Works with OpenAI, Azure OpenAI-compatible gateways and local servers
    (Ollama, vLLM, LM Studio) that expose /v1/chat/completions."""

    def __init__(self, base_url: str, api_key: str, model: str, name: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.name = name

    def extract(self, instruction: str, text: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        body = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You extract structured fields from documents. Return strict JSON matching the "
                        "requested schema. Use null for any field that is not present in the text. "
                        "Never guess, never compute totals that are not written in the text."
                    ),
                },
                {"role": "user", "content": f"{instruction}\n\nSchema: {json.dumps(schema)}\n\nText:\n{text[:24000]}"},
            ],
        }
        headers = {"authorization": f"Bearer {self.api_key}", "content-type": "application/json"}
        try:
            response = httpx.post(
                f"{self.base_url}/chat/completions", json=body, headers=headers, timeout=120.0
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None


SUPPORTED_PROVIDERS = {"openai", "local"}


def get_provider() -> LLMProvider | None:
    """Selects the environment-configured provider; None when none is configured."""
    provider = os.environ.get("AI_LLM_PROVIDER", "").lower()
    model = os.environ.get("AI_LLM_MODEL", "gpt-4o-mini")

    if provider == "openai" and os.environ.get("OPENAI_API_KEY"):
        return OpenAICompatibleProvider(
            os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            os.environ["OPENAI_API_KEY"],
            model,
            "openai",
        )
    if provider == "local" and os.environ.get("AI_LLM_BASE_URL"):
        return OpenAICompatibleProvider(
            os.environ["AI_LLM_BASE_URL"], os.environ.get("AI_LLM_API_KEY", "local"), model, "local"
        )
    return None


def select_provider(options: dict[str, Any] | None = None) -> tuple[LLMProvider | None, list[str]]:
    """Resolves the model the workspace activated in the model registry.

    `options["model"]` is the active `ModelVersion` (name, version, provider,
    artifactUri, parameters). It replaces the environment default so activating
    a model actually changes what runs. An unusable selection falls back to the
    environment provider and says so instead of silently pretending.
    """
    selection = (options or {}).get("model")
    if not isinstance(selection, dict):
        return get_provider(), []

    label = f"{selection.get('name')}:{selection.get('version')}"
    provider = str(selection.get("provider", "")).lower()
    model_name = str(selection.get("baseModel") or selection.get("name") or "")

    if provider not in SUPPORTED_PROVIDERS:
        return get_provider(), [
            f"Active model {label} uses unsupported provider '{provider}'; using the configured default"
        ]

    if provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            return get_provider(), [
                f"Active model {label} needs OPENAI_API_KEY; using the configured default"
            ]
        base_url = str(
            selection.get("artifactUri") or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        )
        return OpenAICompatibleProvider(base_url, api_key, model_name, f"openai/{label}"), []

    base_url = selection.get("artifactUri") or os.environ.get("AI_LLM_BASE_URL")
    if not base_url:
        return get_provider(), [
            f"Active model {label} has no artifact endpoint; using the configured default"
        ]
    return (
        OpenAICompatibleProvider(
            str(base_url), os.environ.get("AI_LLM_API_KEY", "local"), model_name, f"local/{label}"
        ),
        [],
    )
