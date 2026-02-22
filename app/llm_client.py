"""
Thin LLM wrapper.

Controlled by three environment variables:
  LLM_PROVIDER  — 'groq' (default) | 'ollama'
  LLM_API_KEY   — API key for cloud providers (Groq)
  LLM_MODEL     — model name override
                  defaults: groq → 'llama-3.1-8b-instant'
                            ollama → 'llama3'
  OLLAMA_BASE   — base URL for Ollama (default: http://localhost:11434)
"""
import os
import json

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "groq").lower()
LLM_API_KEY  = os.environ.get("LLM_API_KEY", "")
_DEFAULT_MODELS = {
    "groq":   "llama-3.1-8b-instant",
    "ollama": "llama3",
}
LLM_MODEL = os.environ.get("LLM_MODEL", _DEFAULT_MODELS.get(LLM_PROVIDER, "llama-3.1-8b-instant"))


def call_llm(system_prompt: str, user_message: str) -> str:
    """Call the configured LLM and return the raw text response."""
    if LLM_PROVIDER == "groq":
        return _call_groq(system_prompt, user_message)
    elif LLM_PROVIDER == "ollama":
        return _call_ollama(system_prompt, user_message)
    else:
        raise ValueError(f"Unknown LLM_PROVIDER: {LLM_PROVIDER!r}. Choose 'groq' or 'ollama'.")


def _call_groq(system_prompt: str, user_message: str) -> str:
    try:
        from groq import Groq
    except ImportError:
        raise RuntimeError(
            "The 'groq' package is not installed. Add it to environment.yml and rebuild the image."
        )
    if not LLM_API_KEY:
        raise RuntimeError("LLM_API_KEY is not set. Set it in docker-compose.yml or as an env var.")

    client = Groq(api_key=LLM_API_KEY)
    completion = client.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    return completion.choices[0].message.content


def _call_ollama(system_prompt: str, user_message: str) -> str:
    import urllib.request
    OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://localhost:11434")
    payload = json.dumps({
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        "stream": False,
        "format": "json",
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA_BASE}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        data = json.loads(resp.read())
    return data["message"]["content"]
