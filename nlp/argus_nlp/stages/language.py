"""
LANGUAGE IDENTIFICATION.

This stage exists because VADER and `en_core_web_sm` are both English-only and
neither of them tells you when it is out of its depth. VADER hands back
compound = 0.0 for a furious Hindi post - a silent wrong answer that looks
exactly like a genuine neutral on the dashboard. So language detection has to
GATE those two, not sit beside them.

Two signals are combined:

  1. Script detection (unicodedata). Cheap and near-certain: Devanagari or
     Tamil script means the post is not English, whatever a statistical
     detector thinks.

  2. lingua. Chosen over langdetect because it is markedly better on short
     text, and because it reports a confidence per language rather than a bare
     guess - and the confidence is what drives escalation.

On romanised code-mixed text (Tanglish, Hinglish) lingua guesses badly - it
labels "enga ooru Tirunelveli la romba nalla irukku" as Malay at 0.66, and a
Hinglish sentence as Malay at 0.48. That is expected and handled: the LABEL is
wrong but the CONFIDENCE is honest, and low confidence on Latin script sets
`is_code_mixed`, which routes the post to the LLM rather than trusting either
VADER or the bad guess.
"""

from __future__ import annotations

import functools
import re
import unicodedata

from argus_nlp.schema import LanguageInfo

# Languages the detector considers. Restricting the set both cuts memory and
# improves accuracy; widen it in config if the data demands it.
DEFAULT_LANGUAGES = [
    "ENGLISH", "HINDI", "TAMIL", "TELUGU", "BENGALI", "MARATHI", "GUJARATI",
    "PUNJABI", "URDU", "ARABIC", "CHINESE", "JAPANESE", "KOREAN", "RUSSIAN",
    "FRENCH", "GERMAN", "SPANISH", "PORTUGUESE", "ITALIAN", "DUTCH", "TURKISH",
    "INDONESIAN", "MALAY", "VIETNAMESE", "THAI", "PERSIAN", "SWAHILI",
    "FILIPINO", "POLISH", "UKRAINIAN",
]

# Unicode block prefix -> ISO 639-1 code that block implies.
SCRIPT_HINTS = {
    "DEVANAGARI": "hi",
    "TAMIL": "ta",
    "TELUGU": "te",
    "BENGALI": "bn",
    "GUJARATI": "gu",
    "GURMUKHI": "pa",
    "KANNADA": "kn",
    "MALAYALAM": "ml",
    "ORIYA": "or",
    "SINHALA": "si",
    "ARABIC": "ar",
    "HEBREW": "he",
    "CYRILLIC": "ru",
    "GREEK": "el",
    "THAI": "th",
    "HIRAGANA": "ja",
    "KATAKANA": "ja",
    "HANGUL": "ko",
    "CJK": "zh",
}

# Below this, a Latin-script post is probably romanised non-English rather than
# the language lingua named. 0.70 sits above the 0.48-0.66 measured on real
# Tanglish and Hinglish, and below the 0.90+ seen on genuine English and
# French. Kept equal to the escalation threshold so the two rules agree.
CODE_MIX_CONFIDENCE = 0.70
MIN_CHARS_FOR_DETECTION = 8

# Closed-class English words. Statistical detectors get unreliable on short,
# shouty, hashtag-heavy social text - real English like "This is AMAZING!!
# Check" can score as low as 0.36 - but function words are a near-decisive
# signal that survives all of that, and romanised Tamil/Hindi contains almost
# none of them. Used to rescue English that lingua under-scores, never to
# override a confident non-Latin detection.
ENGLISH_FUNCTION_WORDS = frozenset("""
a an the this that these those there here is am are was were be been being
do does did doing have has had having will would shall should can could may
might must and or but if then than so because while when where why how what
who whom which of to in on at by for with from into onto about over under
after before between during without within against i me my we us our you
your he him his she her it its they them their not no nor too very just
only also even still yet all any some most more much many few other such
""".split())

# Two clear function words in a short post is already strong evidence; the
# ratio catches longer text where absolute counts vary.
ENGLISH_RESCUE_MIN_HITS = 2
ENGLISH_RESCUE_MIN_RATIO = 0.18
ENGLISH_RESCUE_SHORT_TOKENS = 8

# A deliberately conservative subset of the above, used for fragments too
# short for lingua to run at all. Words like "me", "a", "no", "in", "so", "he"
# and "la" are dropped because they are ordinary Spanish, French or Italian -
# on a two-word fragment there is no other evidence to outvote them, so only
# words that are distinctively English are allowed to decide.
ENGLISH_DISTINCTIVE_WORDS = frozenset("""
the is are was were this that these those there here am be been being
do does did doing have has had having will would shall should can could
and but if then than because while when where why how what who whom which
of to for with from into onto about over under after before between at
i my your our their its it they we you not too very just only also even
still yet any most much many few such
""".split())

# How many distinctive English words it takes to overrule a language lingua
# actually named. Two, because one can appear by coincidence.
ENGLISH_OVERRIDE_MIN_DISTINCTIVE = 2


@functools.lru_cache(maxsize=4)
def _detector(languages: tuple[str, ...]):
    from lingua import Language, LanguageDetectorBuilder

    langs = []
    for name in languages:
        member = getattr(Language, name, None)
        if member is not None:
            langs.append(member)
    if len(langs) < 2:
        raise ValueError("need at least two languages for detection")
    return LanguageDetectorBuilder.from_languages(*langs).build()


def detect_scripts(text: str) -> dict[str, int]:
    """Count characters per Unicode script. Ignores digits and punctuation."""
    counts: dict[str, int] = {}
    for char in text:
        if not char.isalpha():
            continue
        try:
            name = unicodedata.name(char)
        except ValueError:
            continue
        block = name.split(" ")[0]
        if block == "LATIN":
            key = "LATIN"
        else:
            key = next((k for k in SCRIPT_HINTS if name.startswith(k)), block)
        counts[key] = counts.get(key, 0) + 1
    return counts


def english_function_word_evidence(text: str) -> tuple[int, float, int]:
    """(distinct function words, their share of tokens, total token count).

    Contractions are matched on their stem: "I'm so cold" has to count "i",
    and "it's overrated" has to count "it", or short tweets - which is most of
    social media - look like they contain no English at all.
    """
    words = re.findall(r"[a-z']+", text.lower())
    words = [w.strip("'") for w in words if w.strip("'")]
    if not words:
        return 0, 0.0, 0
    matched = []
    for word in words:
        if word in ENGLISH_FUNCTION_WORDS:
            matched.append(word)
        elif "'" in word and word.split("'")[0] in ENGLISH_FUNCTION_WORDS:
            matched.append(word.split("'")[0])
    return len(set(matched)), len(matched) / len(words), len(words)


def english_distinctive_hits(text: str) -> int:
    """Count distinct unambiguously-English words present.

    Used where the evidence has to be strong enough to overrule the detector,
    so the ambiguous half of the function-word list does not get a vote.
    """
    words = {w.strip("'") for w in re.findall(r"[a-z']+", text.lower())}
    stems = {w.split("'")[0] for w in words if "'" in w}
    return len((words | stems) & ENGLISH_DISTINCTIVE_WORDS)


def detect(text: str, languages: list[str] | None = None) -> LanguageInfo:
    info = LanguageInfo()
    stripped = text.strip()

    if not any(c.isalpha() for c in stripped):
        info.primary_lang = "und"
        info.lang_confidence = 0.0
        return info

    scripts = detect_scripts(stripped)

    if len(stripped) < MIN_CHARS_FOR_DETECTION:
        # Too short for lingua to say anything useful, but fragments like
        # "I see." and "oH NO" are common in social data and do carry
        # sentiment. One distinctively English word, on Latin script, is enough
        # to hand them to VADER. Confidence stays below the escalation
        # threshold so the LLM still verifies them when it is available.
        #
        # A fragment with no such word - "Sorry", "Evicted" - stays "und".
        # There is genuinely nothing to identify it by, and guessing English
        # for every short Latin fragment would swallow Spanish and French.
        words = {w.strip("'") for w in re.findall(r"[a-z']+", stripped.lower())}
        latin_only = scripts.get("LATIN", 0) > 0 and not (
            set(scripts) & set(SCRIPT_HINTS)
        )
        if (words & ENGLISH_DISTINCTIVE_WORDS) and latin_only:
            info.primary_lang = "en"
            info.lang_confidence = 0.60
            info.candidates = [("en", 0.60)]
            return info
        info.primary_lang = "und"
        info.lang_confidence = 0.0
        return info
    total_alpha = sum(scripts.values()) or 1
    non_latin = {k: v for k, v in scripts.items() if k != "LATIN" and k in SCRIPT_HINTS}

    # A dominant non-Latin script is decisive - no statistical model needed.
    if non_latin:
        dominant = max(non_latin, key=lambda k: non_latin[k])
        share = non_latin[dominant] / total_alpha
        if share >= 0.5:
            info.primary_lang = SCRIPT_HINTS[dominant]
            info.lang_confidence = round(min(0.99, 0.6 + share * 0.4), 4)
            info.is_code_mixed = share < 0.9 and scripts.get("LATIN", 0) > 2
            info.candidates = [(info.primary_lang, info.lang_confidence)]
            return info

    try:
        detector = _detector(tuple(languages or DEFAULT_LANGUAGES))
        values = detector.compute_language_confidence_values(stripped)
    except Exception:
        info.primary_lang = "und"
        return info

    info.candidates = [
        (v.language.iso_code_639_1.name.lower(), round(v.value, 4)) for v in values[:5]
    ]
    if not info.candidates or info.candidates[0][1] <= 0.0:
        info.primary_lang = "und"
        info.lang_confidence = 0.0
        return info

    info.primary_lang, info.lang_confidence = info.candidates[0]

    # Rescue English that lingua under-scored. Without this, ordinary English
    # posts with hashtags and shouting get treated as code-mixed and pushed to
    # the paid LLM tier for no reason.
    hits, ratio, tokens = english_function_word_evidence(stripped)
    strong_english = hits >= ENGLISH_RESCUE_MIN_HITS and ratio >= ENGLISH_RESCUE_MIN_RATIO
    # One function word in a very short post is already meaningful - most
    # social posts are this short, and demanding two rejected plain English
    # like "Need a hug" and "Man Work is Hard".
    short_english = hits >= 1 and tokens <= ENGLISH_RESCUE_SHORT_TOKENS
    # Two separate bars, because the two situations carry different risk.
    #
    #   lingua already said English - it just lacked confidence. Any function
    #   word will do to raise it.
    #
    #   lingua named some OTHER language. Overruling that needs distinctively
    #   English evidence: "me", "a", "no", "in", "so" are all ordinary Spanish,
    #   French and Italian, and letting one of them outvote the detector turned
    #   "que me muera" into English at 0.80 - Spanish handed to an English-only
    #   lexicon. Hashtag-heavy English ("This is AMAZING") clears the higher
    #   bar easily; Tanglish and Hinglish clear neither.
    already_english = info.primary_lang == "en" and (strong_english or short_english)
    overrules_detector = (
        english_distinctive_hits(stripped) >= ENGLISH_OVERRIDE_MIN_DISTINCTIVE
    )
    if (already_english or overrules_detector) and not non_latin:
        info.primary_lang = "en"
        info.lang_confidence = max(info.lang_confidence, 0.80)
        info.candidates = [("en", info.lang_confidence)] + [
            c for c in info.candidates if c[0] != "en"
        ][:4]
        return info

    # Weak confidence on Latin script means romanised or code-mixed text - but
    # ONLY when the detector's own best guess is some other language. Low
    # confidence in ENGLISH is still English, just short or informal, and
    # conflating the two discarded 10.7% of an all-English corpus. Genuine
    # Tanglish and Hinglish come back labelled Malay or German, so they are
    # still caught here.
    if (
        info.primary_lang != "en"
        and info.lang_confidence < CODE_MIX_CONFIDENCE
        and scripts.get("LATIN", 0) > 0
    ):
        info.is_code_mixed = True

    # Mixed scripts in one post is code-mixing by definition.
    if scripts.get("LATIN", 0) > 2 and non_latin:
        info.is_code_mixed = True

    return info


def is_english(info: LanguageInfo, min_confidence: float = 0.0) -> bool:
    """Whether it is safe to let VADER and en_core_web_sm handle this post.

    Confidence deliberately does NOT gate this. If the detector's best guess is
    English and nothing suggests code-mixing, VADER should produce a baseline
    score even when confidence is low - a provisional score the LLM can later
    correct beats no score at all, and refusing to score left a tenth of a
    plain-English corpus blank.

    Low confidence still adds a `low_language_conf` escalation reason, so those
    posts get verified when the LLM tier is available. `min_confidence` is kept
    for callers that want the stricter check.
    """
    if info.primary_lang != "en" or info.is_code_mixed:
        return False
    return info.lang_confidence >= min_confidence
