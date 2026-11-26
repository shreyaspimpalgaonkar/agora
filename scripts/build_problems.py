"""Build the Agora problem set.

Source: ProofAtlas "Top 500 Open Math Problems", edition v28 (2026-10-06), the list
Lech Mazur checked against the openai/math release. ProofAtlas edition v30
(2026-10-07) marks 88 of those 500 as solved or disproved by that release.
We keep the other 412 and attach v30's newer status notes to each one.
"""
import json, re, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
v28 = json.load(open(root / "data/top500-v28.json"))
v30 = json.load(open(root / "data/top500-v30.json"))
resolved = {r["problemId"]: r for r in v30["resolvedRecords"]}
current = {r["problemId"]: r for r in v30["records"]}

def mentions_openai(rec):
    if "openai/math" in json.dumps(rec.get("sources", [])):
        return True
    return "OpenAI release" in (rec.get("statusQualification") or "")

open_problems, excluded = [], []
for r in v28["records"]:
    pid = r["problemId"]
    if pid in resolved:
        z = resolved[pid]
        excluded.append({
            "rank": r["releaseRank"], "slug": pid, "title": r["canonicalTitle"],
            "domain": r["primaryDomain"], "domainLabel": r["primaryDomainLabel"],
            "outcome": z["currentStatus"], "note": z["qualification"],
            "sources": [{"citation": s.get("citation"), "url": s.get("url")} for s in z.get("sources", [])][:6],
        })
        continue
    c = current.get(pid, r)
    open_problems.append({
        "rank": r["releaseRank"],
        "slug": pid,
        "title": r["canonicalTitle"],
        "statement": r["exactTarget"],
        "question": r.get("readerQuestion"),
        "why": r.get("whyItMatters"),
        "domain": r["primaryDomain"],
        "domainLabel": r["primaryDomainLabel"],
        "family": r.get("familyLabel"),
        "atlasStatus": c.get("releaseStatus"),
        "atlasNote": c.get("statusQualification"),
        "atlasReviewedAt": c.get("statusReviewedAt"),
        "openaiPartial": mentions_openai(c),
        "consequences": r.get("resolutionConsequences"),
        "formalSource": r.get("formalStatementSource"),
        "sources": [{"citation": s.get("citation"), "url": s.get("url"), "role": s.get("role")} for s in c.get("sources", [])][:10],
        "related": [{"slug": x.get("problemId"), "label": x.get("label"), "relation": x.get("relation")} for x in r.get("relatedProblems", [])][:8],
        "aliases": r.get("aliases") or [],
    })

open_problems.sort(key=lambda p: p["rank"])
excluded.sort(key=lambda p: p["rank"])
meta = {
    "source": "ProofAtlas Top 500 Open Math Problems",
    "sourceUrl": "https://proofatlas.ai/open-problems/",
    "baseEdition": v28["publicationId"], "baseEditionDate": v28["editionDate"],
    "statusEdition": v30["publicationId"], "statusEditionDate": v30["editionDate"],
    "total": len(v28["records"]), "open": len(open_problems), "excluded": len(excluded),
}
json.dump({"meta": meta, "problems": open_problems, "excluded": excluded},
          open(root / "data/problems.json", "w"), ensure_ascii=False, indent=1)
print(meta)
from collections import Counter
print(Counter(p["domainLabel"] for p in open_problems).most_common())
print("openai partial notes:", sum(p["openaiPartial"] for p in open_problems))
