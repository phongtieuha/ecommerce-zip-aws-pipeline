# INDONESIA & VIETNAM

import re
from setup import df_concat_all

def count_bullet_type(text, bullet):
    if not isinstance(text, str):
        return 0
    pattern = r"(?m)(?:^|\n)\s*" + re.escape(bullet) + r"\s*.+"
    return len(re.findall(pattern, text))

def count_words_id_vn(text):
    if not isinstance(text, str) or not text.strip():
        return 0
    return len(text.split())

def count_words_no_bullet(text):
    if not isinstance(text, str) or not text.strip():
        return 0

    bullet_pattern = r"(?m)^\s*(?:-+|•|●)\s+.*$"
    text_no_bullet = re.sub(bullet_pattern, "", text)

    return len(text_no_bullet.split())

def count_bullets_clean(text):
    if not isinstance(text, str):
        return 0

    pattern = r"(?m)^\s*(?:-+|•|●)\s+.+"
    return len(re.findall(pattern, text))

def count_bullets(text):
    if not isinstance(text, str):
        return 0

    bullet_pattern = r"(?m)^\s*(#?\s*[-•\\-])"
    return len(re.findall(bullet_pattern, text))


df_concat_all['word_count'] = df_concat_all['product_desc'].apply(count_words_id_vn)
df_concat_all['word_count_no_bullet'] = df_concat_all['product_desc'].apply(count_words_no_bullet)
df_concat_all['num_bullets'] = df_concat_all['product_desc'].apply(count_bullets_clean)

print("WORD COUNT & BULLETS")
print("="*80)
print(df_concat_all[['product_id', 'word_count', 'word_count_no_bullet', 'num_bullets']].head(4))

bullet_types = ['-', '- ', '\\-', '•', '"•', '&#34;•',
                '&#39;-', '●', '● ', ' ●', '\n\n●', '\n●']

df_concat_all['-'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '-'))
df_concat_all['- '] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '- '))
df_concat_all['\\-'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '\\-'))
df_concat_all['•'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '•'))
df_concat_all['"•'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '"•'))
df_concat_all['&#34;•'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '&#34;•'))
df_concat_all['&#39;-'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '&#39;-'))
df_concat_all['●'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '●'))
df_concat_all['● '] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '● '))
df_concat_all[' ●'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, ' ●'))
df_concat_all['\n\n●'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '\n\n●'))
df_concat_all['\n●'] = df_concat_all['product_desc'].apply(lambda text: count_bullet_type(text, '\n●'))
df_concat_all['num_bullets_upd'] = (
    df_concat_all['\\-'] +
    df_concat_all['•'] +
    df_concat_all['"•'] +
    df_concat_all['&#34;•'] +
    df_concat_all['●'] +
    df_concat_all['● '] +
    df_concat_all[' ●']+
    df_concat_all['&#39;-']+
    df_concat_all['\n\n●']+
    df_concat_all['\n●']
)

print("BULLET TYPE BREAKDOWN")
print("="*80)
print(df_concat_all[['product_id', '-', '- ', '\\-', '•', '"•', '&#34;•', '●', '● ', ' ●', '\n\n●', '\n●']].head(4))
print("\nTOTAL BULLETS (Sum of all types)")
print("="*80)
print(df_concat_all[['product_id', 'num_bullets_upd']].head(4))