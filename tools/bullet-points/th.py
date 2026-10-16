# THAILAND FUNCTIONS
import re
from setup import df_concat_all

try:
    from pythainlp.tokenize import word_tokenize
    PYTHAINLP_OK = True
except ImportError:
    PYTHAINLP_OK = False
    print("pythainlp not installed. Install with: pip install pythainlp")

def count_words_th(text, debug=False):
    if not isinstance(text, str) or not text.strip():
        return 0
    if not PYTHAINLP_OK:
        raise ImportError("pythainlp required")
    all_tokens = word_tokenize(text, engine='newmm')
    thai_char_pattern = re.compile(r'[\u0E00-\u0E7F]')
    latin_pattern = re.compile(r'[A-Za-z0-9]')
    thai_words = []
    latin_words = []
    for token in all_tokens:
        if not token or not token.strip():
            continue
        cleaned = token.strip()

        if thai_char_pattern.search(cleaned):
            thai_words.append(cleaned)
        elif latin_pattern.search(cleaned):
            latin_words.append(cleaned)

    return len(thai_words) + len(latin_words)


def count_words_th_no_bullet(text):
    if not isinstance(text, str) or not text.strip():
        return 0

    if not PYTHAINLP_OK:
        raise ImportError("pythainlp required")

    bullet_pattern = re.compile(r"(?m)^\s*[•\-–▪]\s+.+$")
    text_no_bullet = bullet_pattern.sub("", text)
    all_tokens = word_tokenize(text_no_bullet, engine='newmm')
    thai_char_pattern = re.compile(r'[\u0E00-\u0E7F]')
    latin_pattern = re.compile(r'[A-Za-z0-9]')

    thai_words = []
    latin_words = []

    for token in all_tokens:
        if not token or not token.strip():
            continue

        cleaned = token.strip()
        if thai_char_pattern.search(cleaned):
            thai_words.append(cleaned)
        elif latin_pattern.search(cleaned):
            latin_words.append(cleaned)

    return len(thai_words) + len(latin_words)

def count_bullets_th(text):
    if not isinstance(text, str) or not text.strip():
        return 0
    bullet_pattern = re.compile(
        r"(?m)^\s*[•\-–▪]\s+.+$",
        re.VERBOSE
    )
    return len(bullet_pattern.findall(text))

if PYTHAINLP_OK:
    mask_th = df_concat_all['product_id'].str.contains('th')
    df_concat_all.loc[mask_th, 'word_count_th'] = \
        df_concat_all.loc[mask_th, 'product_desc'].apply(count_words_th)
    df_concat_all.loc[mask_th, 'word_count_th_no_bullet'] = \
        df_concat_all.loc[mask_th, 'product_desc'].apply(count_words_th_no_bullet)
    df_concat_all.loc[mask_th, 'num_bullets_th'] = \
        df_concat_all.loc[mask_th, 'product_desc'].apply(count_bullets_th)
    print("THAILAND - WORD COUNT & BULLETS")
    print("="*80)
    print(
        df_concat_all[
            ['product_id', 'word_count_th', 'word_count_th_no_bullet', 'num_bullets_th']
        ][mask_th]
    )
else:
    print("Skip Thailand - pythainlp not installed")