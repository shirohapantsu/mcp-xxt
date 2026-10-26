#!/usr/bin/env python3
"""增量答题 agent：按关键词表匹配题干生成 answers.json（question_id 用完整 uuid）。
multiple 题的答案给「选项子串列表」→ 按子串挑出完整选项文本 → JSON 数组编码。
judgement 题答案为 '对'/'错'。"""
import json, sys

ANSWERS = [
    ('内省修行', '道、儒、释'),
    ('日本茶道以', '和'),
    ('陆羽亲自设计的技术之道', '茶园生产、茶叶加工、贮藏保管、饮用方法'),
    ('日本茶道源于', '中国'),
    ('第一部关于茶的著作', '《茶经》'),
    ('日本茶道的四规', '和、敬、清、寂'),
    ('四规是', '和、敬、清、寂'),
    ('描述不正确', '茶道是含丰富文化内涵的茶饮质量技术标准'),
    ('茶性无邪', '吴觉农'),
    ('茶道起源于哪个国家', '中国'),
    ('静、净、敬', ['既指环境，又指内心', '净则清，清则明', '对自然、生命心怀恭敬']),
    ('中日茶道参与者', ['日本茶道更具有典型性', '中国茶道更具有民众性']),
    ('中日茶道参与', ['日本茶道更具有典型性', '中国茶道更具有民众性']),
    ('中日茶道差异的主要原因', ['两者的传承方式不同', '两者的思想体系不同']),
    ('茶渗透在百姓生活', ['以茶待客', '以茶馈赠', '婚嫁喝茶', '祭祀茶礼']),
    ('《茶经》内容的阐述', ['饮用好茶的诸多讲究', '适当省略饮茶步骤']),
    ('涉茶所用器具', ['二之具', '四之器']),
    ('典型的文化特征', ['示礼至和乐', '检德可行道', '洁性不可污']),
    ('《嘉叶传》', '错'),
    ('中日茶道都是将', '对'),
    ('追求的最高境界', '对'),
    ('精心设计了专用', '对'),
    ('饮茶器具', '对'),
    ('最早出现在中国', '对'),
    ('一词最早出现', '对'),
]

def main():
    d = json.load(open('questions.json'))
    old = {}
    try:
        old = {a['question_id']: a['answer'] for a in json.load(open('answers.json'))['answers']}
    except Exception:
        pass
    answers = []
    for q in d['questions']:
        if q['id'] in old:
            answers.append({'question_id': q['id'], 'answer': old[q['id']]})
            continue
        hit = None
        for kw, a in ANSWERS:
            if kw in q['title']:
                if isinstance(a, list):
                    hit = [opt for opt in q.get('options', []) if any(sub in opt for sub in a)]
                else:
                    hit = a
                break
        if hit is None:
            print(f"[无答案] {q['id'][:8]} {q['type']} | {q['title'][:50]}", file=sys.stderr)
        else:
            answers.append({'question_id': q['id'], 'answer': hit})
    json.dump({'answers': answers}, open('answers.json', 'w'), ensure_ascii=False)
    print(f"answers.json: {len(answers)} 条")

if __name__ == '__main__':
    main()
