"""
Thin LLM wrapper.

Controlled by environment variables:
  LLM_PROVIDER   'saia' (default) | 'openai' | 'groq' | 'ollama'
  LLM_API_KEY    API key for the cloud providers
  LLM_MODEL      model name override (see _DEFAULT_MODELS)
  LLM_BASE_URL   override the provider's base URL
  OLLAMA_BASE    base URL for Ollama (default http://localhost:11434)

'saia' is GWDG's Scalable AI Accelerator (https://chat-ai.academiccloud.de/v1),
an academic service that implements the OpenAI API. It and 'openai' share one
implementation; anything else speaking that protocol works by setting
LLM_BASE_URL.

The OpenAI-compatible path deliberately uses urllib rather than the openai
package: it keeps this dependency-free, so switching provider does not mean
rebuilding the base image (~15 minutes on the deployment host).
"""

import json
import os
import re
import urllib.error
import urllib.request

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "saia").lower()
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")

_DEFAULT_MODELS = {
    "saia": "meta-llama-3.1-8b-instruct",
    "openai": "gpt-4o-mini",
    "groq": "llama-3.1-8b-instant",
    "ollama": "llama3",
}
_DEFAULT_BASES = {
    "saia": "https://chat-ai.academiccloud.de/v1",
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
}

LLM_MODEL = os.environ.get("LLM_MODEL") or _DEFAULT_MODELS.get(LLM_PROVIDER, "meta-llama-3.1-8b-instruct")
LLM_BASE_URL = (os.environ.get("LLM_BASE_URL") or _DEFAULT_BASES.get(LLM_PROVIDER, "")).rstrip("/")

# Providers that need no key (local Ollama) vs. those that do.
_NEEDS_KEY = {"saia", "openai", "groq"}


def needs_api_key() -> bool:
    return LLM_PROVIDER in _NEEDS_KEY


def call_llm(system_prompt: str, user_message: str) -> str:
    """Call the configured LLM and return the raw text response."""
    if LLM_PROVIDER == "ollama":
        return _call_ollama(system_prompt, user_message)
    if LLM_PROVIDER in ("saia", "openai", "groq") or LLM_BASE_URL:
        return _call_openai_compatible(system_prompt, user_message)
    raise ValueError(
        f"Unknown LLM_PROVIDER: {LLM_PROVIDER!r}. "
        "Choose 'saia', 'openai', 'groq' or 'ollama', or set LLM_BASE_URL."
    )


def _post(url: str, payload: dict, headers: dict, timeout: int = 120):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read())


def _call_openai_compatible(system_prompt: str, user_message: str) -> str:
    if not LLM_BASE_URL:
        raise RuntimeError("LLM_BASE_URL is not set for this provider.")
    if needs_api_key() and not LLM_API_KEY:
        raise RuntimeError(
            f"LLM_API_KEY is not set for provider {LLM_PROVIDER!r}. Add it to .env and restart."
        )

    url = f"{LLM_BASE_URL}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {LLM_API_KEY}",
    }
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.0,
        "response_format": {"type": "json_object"},
    }

    try:
        data = _post(url, payload, headers)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:400]
        # Not every open model on an OpenAI-compatible endpoint supports
        # response_format. Retry once without it; the prompt asks for JSON
        # anyway and _extract_json below copes with fenced output.
        if exc.code in (400, 422) and "response_format" in payload:
            payload.pop("response_format")
            try:
                data = _post(url, payload, headers)
            except urllib.error.HTTPError as exc2:
                raise RuntimeError(
                    f"{LLM_PROVIDER} returned HTTP {exc2.code}: "
                    f"{exc2.read().decode(errors='replace')[:400]}"
                ) from None
        elif exc.code in (401, 403):
            raise RuntimeError(
                f"{LLM_PROVIDER} rejected the API key (HTTP {exc.code}). "
                f"Check LLM_API_KEY. Response: {body}"
            ) from None
        else:
            raise RuntimeError(f"{LLM_PROVIDER} returned HTTP {exc.code}: {body}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc.reason}") from None

    try:
        return _extract_json(data["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(f"Unexpected response shape from {LLM_PROVIDER}: {str(data)[:300]}") from None


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


def _extract_json(text: str) -> str:
    """Return the JSON object in an LLM reply.

    Open models often wrap JSON in a markdown fence or add a sentence around it,
    especially when response_format is unavailable. The caller does a bare
    json.loads and reports a 422 otherwise, so unwrap here.
    """
    if not text:
        return text
    text = text.strip()
    m = _FENCE.search(text)
    if m:
        return m.group(1).strip()
    if text.startswith("{") or text.startswith("["):
        return text
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return text[start:end + 1]
    return text


def _call_ollama(system_prompt: str, user_message: str) -> str:
    base = os.environ.get("OLLAMA_BASE", "http://localhost:11434")
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "stream": False,
        "format": "json",
    }
    data = _post(f"{base}/api/chat", payload, {"Content-Type": "application/json"}, timeout=120)
    return _extract_json(data["message"]["content"])


def list_models() -> list[str]:
    """Model ids the configured endpoint offers — handy for checking LLM_MODEL."""
    if not LLM_BASE_URL:
        return []
    req = urllib.request.Request(
        f"{LLM_BASE_URL}/models", headers={"Authorization": f"Bearer {LLM_API_KEY}"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        data = json.loads(resp.read())
    return sorted(m.get("id", "") for m in data.get("data", []))
