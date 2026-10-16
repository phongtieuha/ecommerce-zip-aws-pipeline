# PHILIPPINES FUNCTIONS
import re
from setup import df_concat_all

def count_words_ph(text):
    if not isinstance(text, str) or not text.strip():
        return 0

    word_pattern = re.compile(
        r"""
        \b
        [A-Za-z0-9]+
        (?:[-/][A-Za-z0-9]+)*
        \b
        """,
        re.VERBOSE
    )

    return len(word_pattern.findall(text))


def count_words_ph_no_bullet(text):
    if not isinstance(text, str) or not text.strip():
        return 0

    bullet_pattern = re.compile(r"(?m)^\s*[•\-–▪]\s+.+$")
    text_no_bullet = bullet_pattern.sub("", text)

    word_pattern = re.compile(
        r"""
        \b
        [A-Za-z0-9]+
        (?:[-/][A-Za-z0-9]+)*
        \b
        """,
        re.VERBOSE
    )

    return len(word_pattern.findall(text_no_bullet))


def count_bullets_ph(text):
    if not isinstance(text, str) or not text.strip():
        return 0

    bullet_pattern = re.compile(
        r"(?m)^\s*[•\-–▪]\s+.+$",
        re.VERBOSE
    )

    return len(bullet_pattern.findall(text))


mask_ph = df_concat_all['product_id'].str.contains('ph')

df_concat_all.loc[mask_ph, 'word_count_ph'] = \
    df_concat_all.loc[mask_ph, 'product_desc'].apply(count_words_ph)

df_concat_all.loc[mask_ph, 'word_count_ph_no_bullet'] = \
    df_concat_all.loc[mask_ph, 'product_desc'].apply(count_words_ph_no_bullet)

df_concat_all.loc[mask_ph, 'num_bullets_ph'] = \
    df_concat_all.loc[mask_ph, 'product_desc'].apply(count_bullets_ph)

print("PHILIPPINES - WORD COUNT & BULLETS")
print("="*80)
print(
    df_concat_all[
        ['product_id', 'word_count_ph', 'word_count_ph_no_bullet', 'num_bullets_ph']
    ][mask_ph]
)