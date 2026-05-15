"""Minimal Google Gemini wrapper for optional AI features. Never used for certificate validity."""

from __future__ import annotations

import logging

from app.config import Config

logger = logging.getLogger(__name__)

# HttpOptions.timeout for google-genai is milliseconds (see google.genai._api_client.get_timeout_in_seconds).
_REQUEST_TIMEOUT_MS = 120_000


class GeminiNotConfiguredError(Exception):
    """Raised when GEMINI_API_KEY is missing or empty."""


class GeminiError(Exception):
    """Generation or upstream failure (timeouts, empty response, API errors)."""


def is_configured() -> bool:
    return bool((Config.GEMINI_API_KEY or "").strip())


def generate_text(prompt: str, *, system_instruction: str | None = None) -> str:
    """
    Call Gemini with a user prompt. Does not log prompt contents.
    Raises GeminiNotConfiguredError if no API key; GeminiError on failure.
    """
    if not is_configured():
        raise GeminiNotConfiguredError("Gemini not configured")

    text_in = (prompt or "").strip()
    if not text_in:
        raise GeminiError("Prompt is empty")

    # Lazy import: requires PyPI package ``google-genai`` (``from google import genai``). A bare ``google`` or only
    # ``google-generativeai`` (legacy) causes ImportError — do not let that bubble as HTTP 500 on risk-hints.
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        logger.warning("Google GenAI SDK import failed: %s", e)
        raise GeminiError(
            "Google GenAI SDK is missing or incompatible. In backend/: "
            "`pip install google-genai` (prefer the project venv: `.venv\\Scripts\\activate` then install). "
            f"Details: {e!s}"
        ) from e

    api_key = Config.GEMINI_API_KEY.strip()
    model = (Config.GEMINI_MODEL or "gemini-1.5-flash").strip()

    http_options = types.HttpOptions(timeout=_REQUEST_TIMEOUT_MS)
    client = genai.Client(api_key=api_key, http_options=http_options)

    gen_config = None
    if system_instruction and system_instruction.strip():
        gen_config = types.GenerateContentConfig(system_instruction=system_instruction.strip())

    try:
        response = client.models.generate_content(
            model=model,
            contents=text_in,
            config=gen_config,
        )
    except Exception as e:
        logger.warning("Gemini request failed (%s)", type(e).__name__)
        raise GeminiError("Gemini request failed") from e

    out = getattr(response, "text", None)
    if out is not None and str(out).strip():
        return str(out).strip()

    finish = None
    try:
        cands = getattr(response, "candidates", None) or []
        if cands:
            finish = getattr(cands[0], "finish_reason", None)
    except Exception:
        finish = None

    logger.warning("Gemini returned no text (finish_reason=%s)", finish)
    raise GeminiError("Gemini returned no text")
