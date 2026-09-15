"""Activating a model in the registry has to change what actually runs."""

from __future__ import annotations

import pytest

from app.providers import select_provider


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "AI_LLM_PROVIDER",
        "AI_LLM_MODEL",
        "AI_LLM_BASE_URL",
        "AI_LLM_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)


def test_no_selection_falls_back_to_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_LLM_PROVIDER", "local")
    monkeypatch.setenv("AI_LLM_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("AI_LLM_MODEL", "env-model")

    provider, warnings = select_provider({})
    assert warnings == []
    assert provider is not None
    assert provider.name == "local"
    assert provider.model == "env-model"


def test_active_local_model_replaces_the_environment_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_LLM_PROVIDER", "local")
    monkeypatch.setenv("AI_LLM_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("AI_LLM_MODEL", "env-model")

    provider, warnings = select_provider(
        {
            "model": {
                "name": "invoice-reader",
                "version": "3",
                "provider": "local",
                "baseModel": "qwen2.5:7b",
                "artifactUri": "http://gpu-box:8001/v1",
            }
        }
    )
    assert warnings == []
    assert provider is not None
    assert provider.name == "local/invoice-reader:3"
    assert provider.model == "qwen2.5:7b"
    assert provider.base_url == "http://gpu-box:8001/v1"


def test_unsupported_provider_falls_back_and_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_LLM_PROVIDER", "local")
    monkeypatch.setenv("AI_LLM_BASE_URL", "http://localhost:11434/v1")

    provider, warnings = select_provider(
        {"model": {"name": "m", "version": "1", "provider": "acme-cloud"}}
    )
    assert provider is not None
    assert provider.name == "local"
    assert "acme-cloud" in warnings[0]


def test_missing_credentials_fall_back_instead_of_failing() -> None:
    provider, warnings = select_provider(
        {"model": {"name": "m", "version": "1", "provider": "openai"}}
    )
    assert provider is None  # nothing configured in the environment either
    assert "OPENAI_API_KEY" in warnings[0]


def test_local_model_without_an_endpoint_falls_back() -> None:
    provider, warnings = select_provider(
        {"model": {"name": "m", "version": "1", "provider": "local"}}
    )
    assert provider is None
    assert "artifact endpoint" in warnings[0]
