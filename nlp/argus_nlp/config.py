"""Settings for Module 5. Environment variables win over config.yaml defaults."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:                                  # yaml is optional
    yaml = None

try:
    from dotenv import dotenv_values
except ImportError:                                  # dotenv is optional
    dotenv_values = None

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent
RESOURCES = PACKAGE_ROOT / "resources"


def _as_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class LLMSettings:
    """MiniMax. Kept behind this dataclass + the LLMClient interface so that
    swapping provider is a config change, not a rewrite (see plan C10)."""

    api_key: str | None = None
    base_url: str = "https://api.minimax.io/v1/text/chatcompletion_v2"
    model: str = "MiniMax-Text-01"
    # 30s was too tight once the prompt asked for event fields as well: a
    # 10-post batch runs ~830 completion tokens and takes ~40s, so every call
    # timed out, burned its retries, and 51 of 112 escalated posts silently
    # fell back to the tier-1 answer. Sized with headroom instead.
    timeout_s: float = 120.0
    # Pinned rather than left to the provider default, so a longer prompt can
    # never quietly truncate the JSON mid-array.
    max_tokens: int = 4096
    max_retries: int = 3
    batch_size: int = 10
    daily_call_cap: int = 2000
    enabled: bool = True

    @property
    def available(self) -> bool:
        return self.enabled and bool(self.api_key)


@dataclass
class EscalationSettings:
    """Thresholds for the VADER -> MiniMax decision (plan C5)."""

    # |compound| below this is treated as a weak signal and escalated.
    #
    # Set from measurement, not intuition. VADER turns out to be well
    # calibrated - its accuracy rises monotonically with |compound| on the
    # Sentiment140 test set - but the old 0.35 kept far too much:
    #
    #     |compound|      n    VADER correct
    #     0.30 - 0.45    38         66%
    #     0.45 - 0.60    59         80%
    #     0.60 - 0.75    61         82%
    #     0.75 - 0.90    58         91%
    #     0.90 +         15        100%
    #
    # MiniMax averages 87.6%, so anything VADER scores below ~0.75 is a post
    # the LLM handles better. Split-half validation puts the exact optimum
    # somewhere in 0.45-0.75 - the halves disagree on where, so that precision
    # is noise - but every value in that band beat 0.35 on BOTH halves.
    # 0.45 is the cheapest of them: +1.2% accuracy for +8% escalation.
    #
    # Re-measure on your own data with scripts/tune_escalation.py.
    weak_compound: float = 0.45
    min_lang_confidence: float = 0.7
    mixed_polarity: float = 0.30     # pos and neg both above this
    min_tokens: int = 2              # below this, never escalate - not enough text

    # The main cost dial.
    #
    # "No lexicon match" means VADER recognised no sentiment word at all, which
    # covers two very different posts: a factual announcement that really is
    # neutral, and a post like "Heavy flooding in Thoothukudi, NDRF deployed"
    # that is plainly negative in meaning but uses no word VADER knows. Nothing
    # available to VADER distinguishes them, so this is a genuine trade-off:
    #
    #   True  - catches the second kind, at the price of also paying to confirm
    #           the first kind is neutral. Better recall on harmful content.
    #   False - much cheaper, and misses negatives that carry no sentiment word.
    #
    # Default True because for this problem statement missing a rising harmful
    # narrative is worse than an avoidable API call. Measure both with
    # scripts/run_batch.py --report before deciding.
    escalate_no_lexicon_match: bool = True

    # Questions defeat lexicon matching: the sentiment word belongs to the
    # thing being asked about, not to the writer's own view. VADER scores them
    # confidently and therefore never escalates them on its own.
    escalate_questions: bool = True

    # Confidence floor for the transformer tier. Below this it is guessing:
    # measured 59% correct in 0.50-0.70 against 93%+ above 0.85. Escalating
    # below 0.60 takes overall accuracy from 86.6% to 88.5% while calling the
    # LLM on only 11% of posts (VADER needed help on 60%).
    model_confidence_floor: float = 0.60


@dataclass
class Settings:
    # Tier 1. The transformer is markedly better than VADER and needs the LLM
    # far less often; VADER is kept as an automatic fallback so the pipeline
    # still runs where torch or the weights are missing.
    use_transformer_tier1: bool = True
    transformer_model: str = "cardiffnlp/twitter-roberta-base-sentiment-latest"

    spacy_english_model: str = "en_core_web_sm"
    spacy_multilingual_model: str = "xx_ent_wiki_sm"
    spacy_batch_size: int = 64
    spacy_n_process: int = 1

    hash_salt: str = "argus-dev-salt"      # override in production
    redact_pii: bool = True

    cache_path: Path = PROJECT_ROOT / ".cache" / "llm_cache.sqlite"

    llm: LLMSettings = field(default_factory=LLMSettings)
    escalation: EscalationSettings = field(default_factory=EscalationSettings)

    supabase_url: str | None = None
    supabase_key: str | None = None

    @classmethod
    def load(cls, config_path: Path | None = None) -> "Settings":
        # Read .env, or every lookup below silently returns None and the whole
        # documented .env workflow does nothing.
        #
        # dotenv_values() rather than load_dotenv(): the latter mutates the
        # real os.environ, which leaks between tests and makes the result
        # depend on what ran first. This reads the file into a plain dict and
        # leaves the process environment alone. A real `set VAR=...` still
        # wins - env() checks os.environ first.
        file_env: dict = {}
        if dotenv_values is not None:
            file_env = dotenv_values(PROJECT_ROOT / ".env")

        def env(name: str, default: str | None = None) -> str | None:
            value = os.environ.get(name) or file_env.get(name)
            return value if value not in (None, "") else default

        data: dict = {}
        path = config_path or PROJECT_ROOT / "config.yaml"
        if yaml is not None and path.exists():
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

        s = cls()

        nlp_cfg = data.get("nlp", {})
        s.spacy_english_model = nlp_cfg.get("english_model", s.spacy_english_model)
        s.spacy_multilingual_model = nlp_cfg.get("multilingual_model", s.spacy_multilingual_model)
        s.spacy_batch_size = int(nlp_cfg.get("batch_size", s.spacy_batch_size))
        s.spacy_n_process = int(nlp_cfg.get("n_process", s.spacy_n_process))

        privacy_cfg = data.get("privacy", {})
        s.hash_salt = env("ARGUS_HASH_SALT", privacy_cfg.get("hash_salt", s.hash_salt))
        s.redact_pii = _as_bool(env("ARGUS_REDACT_PII"), privacy_cfg.get("redact_pii", s.redact_pii))

        llm_cfg = data.get("llm", {})
        s.llm = LLMSettings(
            api_key=env("MINIMAX_API_KEY"),
            base_url=env("MINIMAX_BASE_URL", llm_cfg.get("base_url", LLMSettings.base_url)),
            model=env("MINIMAX_MODEL", llm_cfg.get("model", LLMSettings.model)),
            timeout_s=float(llm_cfg.get("timeout_s", LLMSettings.timeout_s)),
            max_tokens=int(llm_cfg.get("max_tokens", LLMSettings.max_tokens)),
            max_retries=int(llm_cfg.get("max_retries", LLMSettings.max_retries)),
            batch_size=int(llm_cfg.get("batch_size", LLMSettings.batch_size)),
            daily_call_cap=int(llm_cfg.get("daily_call_cap", LLMSettings.daily_call_cap)),
            enabled=_as_bool(env("ARGUS_LLM_ENABLED"), llm_cfg.get("enabled", True)),
        )

        esc_cfg = data.get("escalation", {})
        s.escalation = EscalationSettings(
            weak_compound=float(esc_cfg.get("weak_compound", EscalationSettings.weak_compound)),
            min_lang_confidence=float(esc_cfg.get("min_lang_confidence", EscalationSettings.min_lang_confidence)),
            mixed_polarity=float(esc_cfg.get("mixed_polarity", EscalationSettings.mixed_polarity)),
            min_tokens=int(esc_cfg.get("min_tokens", EscalationSettings.min_tokens)),
            escalate_no_lexicon_match=bool(
                esc_cfg.get("escalate_no_lexicon_match",
                            EscalationSettings.escalate_no_lexicon_match)
            ),
            escalate_questions=bool(
                esc_cfg.get("escalate_questions", EscalationSettings.escalate_questions)
            ),
            model_confidence_floor=float(
                esc_cfg.get("model_confidence_floor",
                            EscalationSettings.model_confidence_floor)
            ),
        )

        s.use_transformer_tier1 = _as_bool(
            env("ARGUS_USE_TRANSFORMER"),
            data.get("nlp", {}).get("use_transformer_tier1", s.use_transformer_tier1),
        )
        s.transformer_model = env(
            "ARGUS_TRANSFORMER_MODEL",
            data.get("nlp", {}).get("transformer_model", s.transformer_model),
        )

        s.supabase_url = env("SUPABASE_URL")
        s.supabase_key = env("SUPABASE_SERVICE_KEY") or env("SUPABASE_ANON_KEY")

        cache_dir = data.get("cache", {}).get("path")
        if cache_dir:
            s.cache_path = Path(cache_dir)

        return s


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.load()
    return _settings


def reset_settings() -> None:
    """Test hook - forces the next get_settings() to re-read env/yaml."""
    global _settings
    _settings = None
