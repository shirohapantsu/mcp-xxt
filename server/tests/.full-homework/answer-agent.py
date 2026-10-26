#!/usr/bin/env python3
"""作业答题 agent：关键词表 → 完整 question_id → answers.json。
single/judgement 直接给答案文本；multiple 给选项子串列表。"""
import json, sys

ANSWERS = [
    ('赫塞和布兰查德认为，领导是', '一个在特定情境中，通过影响个体或群体的行为来努力实现目标的过程'),
    # 职位权力 = 法定/奖赏/强制；参照权力属个人权力
    ('不属于领导者职位权力的来源', '参照权力'),
    # 品质/作风/魅力 → 参照权力（感召性）
    ('认同感和归属感', '参照权力'),
    # 领导三要素：领导者、被领导者、情境；组织结构不属于
    ('不属于领导三要素', '组织结构'),
    # Kotter：领导带来变革，管理维持秩序
    ('领导和管理的区别', '领导能带来变革和创新，管理则维持秩序'),
    ('两者的主要功能不同', '领导能带来变革和创新，管理则维持秩序'),
    # 伟人史观 → 特质理论
    ('历史是由伟人创造的', '领导特质理论'),
    ('最接近于', '领导特质理论'),
    # 俄亥俄州立：高关怀-高定规（双高）最优
    ('俄亥俄州立大学', '高关怀—高定规'),
    # 明茨伯格决策类角色：企业家、障碍处理者（干扰应对）、资源分配者、谈判者；
    # 「领导者」属人际类角色
    ('决策类角色', '领导者'),
    # 领导理论主要研究领导行为与过程（动词义），不是名词身份 → 错
    ('管理学中的领导理论主要研究的是前者', '错'),
    ('既指称领导者', '错'),
    # 权力来源多元（专家/参照等个人权力），不只组织结构 → 错
    ('只能来源于组织结构', '错'),
    # 管理职能含计划/决策/组织/领导/控制，领导是其中一部分 → 对
    ('领导是管理的一个部分', '对'),
    ('决策、组织和控制', '对'),
    # 领导行为 = f(领导者, 被领导者, 情境)
    ('复合函数', '对'),
    ('三者的复合函数', '对'),
    # 被领导者对领导效果有主动影响（非被动）→ 错
    ('只是被动接受指令', '错'),
    ('不会产生影响', '错'),
    ('被领导者只是被动', '错'),
    # 专家权力取决于知识完备程度与下属知觉 → 对
    ('知识的完备程度', '对'),
    ('专家权力的大小', '对'),
    # 个人权力 → 认同追随；奖赏/惩罚是职位权力特征 → 错
    ('希望获得奖赏或害怕惩罚', '错'),
    ('个人权力发挥影响', '错'),
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
            print(f"[无答案] {q['id'][:8]} {q['type']} | {q['title'][:55]} | {json.dumps(q.get('options', []), ensure_ascii=False)[:170]}", file=sys.stderr)
        else:
            answers.append({'question_id': q['id'], 'answer': hit})
    json.dump({'answers': answers}, open('answers.json', 'w'), ensure_ascii=False)
    print(f"answers.json: {len(answers)} 条")

if __name__ == '__main__':
    main()
