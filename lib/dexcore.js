/**
 * @file lib/dexcore.js
 * @description ポケモン全姿図鑑の純関数モジュール。
 * 文字正規化・検索絞り込み・件数集計・サジェスト候補生成・表示行組み立てを提供します。
 */
(function () {
  "use strict";

  /**
   * 文字列を検索・比較用に正規化します。
   * 1. null / undefined を空文字にして文字列へ変換
   * 2. Unicode NFKC 正規化
   * 3. 小文字化
   * 4. ひらがなをカタカナへ変換
   * 5. 空白類、中黒、長音符、ハイフン類、丸括弧・角括弧を除去
   *
   * @param {*} value - 対象の入力値
   * @returns {string} 正規化された文字列
   */
  function normalizeText(value) {
    if (value === null || value === undefined) {
      return "";
    }
    let s = String(value).normalize("NFKC").toLowerCase();
    // ひらがな（U+3041〜U+3096）をカタカナ（+0x60）へ変換
    s = s.replace(/[\u3041-\u3096]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
    // 空白類、・、ー、ハイフン類（- U+2010〜U+2015 U+2212）、() [] を取り除く
    s = s.replace(/[\s\u30FB\u30FC\u2010\u2011\u2012\u2013\u2014\u2015\u2212\-\(\)\[\]]/g, "");
    return s;
  }

  /**
   * 入力値から全国番号（1〜1025）をパースします。
   * 先頭の no.・no・# を1つだけ除去し、数字のみで構成されているか判定します。
   *
   * @param {*} value - 入力値
   * @returns {number|null} 1〜1025 の整数、または null
   */
  function parseDexNumber(value) {
    if (value === null || value === undefined) {
      return null;
    }
    let s = String(value).normalize("NFKC").trim();
    // 先頭の no.・no・# を1つだけ取り除く（大文字小文字不問）
    s = s.replace(/^(?:no\.?|#)/i, "").trim();
    if (!/^\d+$/.test(s)) {
      return null;
    }
    const n = parseInt(s, 10);
    if (n < 1 || n > 1025) {
      return null;
    }
    return n;
  }

  /**
   * 既定の検索条件オブジェクトを作成します。
   *
   * @returns {object} 検索条件
   */
  function createCondition() {
    return {
      text: "",
      speciesNo: null,
      entryId: null,
      tags: {},
      excludeTags: [],
      types: [],
      typeMode: "any",
      showNeedsReview: true,
    };
  }

  /**
   * 検索条件によって絞り込みが行われているかを判定します。
   * showNeedsReview の切り替え単体では false を返します。
   *
   * @param {object} cond - 検索条件
   * @returns {boolean} 絞り込み中なら true
   */
  function isFiltering(cond) {
    if (!cond) {
      return false;
    }
    const normText = normalizeText(cond.text);
    if (normText !== "") {
      return true;
    }
    if (parseDexNumber(cond.text) !== null) {
      return true;
    }
    if (cond.speciesNo !== null && cond.speciesNo !== undefined) {
      return true;
    }
    if (cond.entryId !== null && cond.entryId !== undefined) {
      return true;
    }
    if (cond.tags && typeof cond.tags === "object") {
      const groups = Object.keys(cond.tags);
      for (let i = 0; i < groups.length; i++) {
        const arr = cond.tags[groups[i]];
        if (Array.isArray(arr) && arr.length > 0) {
          return true;
        }
      }
    }
    if (Array.isArray(cond.types) && cond.types.length > 0) {
      return true;
    }
    if (Array.isArray(cond.excludeTags) && cond.excludeTags.length > 0) {
      return true;
    }
    return false;
  }

  /**
   * 条件に一致するエントリを抽出します（元の並び順を維持）。
   *
   * @param {Array<object>} entries - 全エントリの配列
   * @param {object} cond - 検索条件
   * @returns {Array<object>} 一致したエントリの配列
   */
  function filterEntries(entries, cond) {
    if (!Array.isArray(entries)) {
      return [];
    }
    if (!cond) {
      return entries.slice();
    }

    const normText = normalizeText(cond.text);
    const dexNum = parseDexNumber(cond.text);
    const hasTextFilter = normText !== "" || dexNum !== null;

    const result = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;

      if (cond.showNeedsReview === false && entry.status === "needs_review") {
        continue;
      }

      if (cond.speciesNo !== null && cond.speciesNo !== undefined && entry.no !== cond.speciesNo) {
        continue;
      }

      if (cond.entryId !== null && cond.entryId !== undefined && entry.id !== cond.entryId) {
        continue;
      }

      if (hasTextFilter) {
        if (normText !== "") {
          const matchKey = Array.isArray(entry.keys) && entry.keys.some(function (k) {
            return typeof k === "string" && k.includes(normText);
          });
          const matchNum = dexNum !== null && entry.no === dexNum;
          if (!matchKey && !matchNum) {
            continue;
          }
        } else if (dexNum !== null) {
          if (entry.no !== dexNum) {
            continue;
          }
        }
      }

      if (cond.tags && typeof cond.tags === "object") {
        let tagsMismatch = false;
        const groups = Object.keys(cond.tags);
        const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
        for (let g = 0; g < groups.length; g++) {
          const selected = cond.tags[groups[g]];
          if (Array.isArray(selected) && selected.length > 0) {
            let hasTag = false;
            for (let t = 0; t < selected.length; t++) {
              if (entryTags.includes(selected[t])) {
                hasTag = true;
                break;
              }
            }
            if (!hasTag) {
              tagsMismatch = true;
              break;
            }
          }
        }
        if (tagsMismatch) {
          continue;
        }
      }

      // 除外に指定したタグを1つでも持つ姿は対象から外す
      if (Array.isArray(cond.excludeTags) && cond.excludeTags.length > 0) {
        const ownTags = Array.isArray(entry.tags) ? entry.tags : [];
        let excluded = false;
        for (let t = 0; t < cond.excludeTags.length; t++) {
          if (ownTags.includes(cond.excludeTags[t])) {
            excluded = true;
            break;
          }
        }
        if (excluded) {
          continue;
        }
      }

      if (Array.isArray(cond.types) && cond.types.length > 0) {
        const entryTypes = Array.isArray(entry.types) ? entry.types : [];
        if (cond.typeMode === "all") {
          let hasAll = true;
          for (let t = 0; t < cond.types.length; t++) {
            if (!entryTypes.includes(cond.types[t])) {
              hasAll = false;
              break;
            }
          }
          if (!hasAll) {
            continue;
          }
        } else {
          // "any"
          let hasAny = false;
          for (let t = 0; t < cond.types.length; t++) {
            if (entryTypes.includes(cond.types[t])) {
              hasAny = true;
              break;
            }
          }
          if (!hasAny) {
            continue;
          }
        }
      }

      result.push(entry);
    }

    return result;
  }

  /**
   * 一致したエントリ群から件数を集計します。
   *
   * @param {Array<object>} matched - 一致エントリの配列
   * @returns {{ species: number, forms: number, reps: number, extras: number, included: number, needsReview: number }}
   */
  function summarize(matched) {
    const speciesSet = new Set();
    let forms = 0;
    let reps = 0;
    let extras = 0;
    let included = 0;
    let needsReview = 0;

    if (Array.isArray(matched)) {
      forms = matched.length;
      for (let i = 0; i < matched.length; i++) {
        const e = matched[i];
        if (!e) continue;
        if (e.no !== null && e.no !== undefined) {
          speciesSet.add(e.no);
        }
        if (e.rep === true) {
          reps++;
        } else if (e.rep === false) {
          extras++;
        }
        if (e.status === "included") {
          included++;
        } else if (e.status === "needs_review") {
          needsReview++;
        }
      }
    }

    return {
      species: speciesSet.size,
      forms: forms,
      reps: reps,
      extras: extras,
      included: included,
      needsReview: needsReview,
    };
  }

  /**
   * 各タグを単独で選んだ場合の対象姿数を計算します。
   * 系統ごとに、他系統の条件を維持した集合を一度だけ求めて高速に集計します。
   *
   * @param {Array<object>} entries - 全エントリの配列
   * @param {object} cond - 現在の検索条件
   * @param {Array<object>} tags - タグ一覧（{ id, label, group } の配列）
   * @returns {Object.<string, number>} { タグID: 姿数 }
   */
  function facetCounts(entries, cond, tags) {
    const result = {};
    if (!Array.isArray(tags) || tags.length === 0) {
      return result;
    }

    const tagsByGroup = {};
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (!tag || tag.id === undefined) continue;
      const g = tag.group !== undefined ? String(tag.group) : "";
      if (!tagsByGroup[g]) {
        tagsByGroup[g] = [];
      }
      tagsByGroup[g].push(tag);
    }

    const groupKeys = Object.keys(tagsByGroup);
    for (let k = 0; k < groupKeys.length; k++) {
      const g = groupKeys[k];
      const groupTags = tagsByGroup[g];

      const copiedTags = {};
      if (cond && cond.tags && typeof cond.tags === "object") {
        const origKeys = Object.keys(cond.tags);
        for (let j = 0; j < origKeys.length; j++) {
          const ok = origKeys[j];
          if (ok !== g && Array.isArray(cond.tags[ok])) {
            copiedTags[ok] = cond.tags[ok].slice();
          }
        }
      }

      // 同じ系統のタグの除外も外して数える（除外中のタグには「除外される姿の数」が出る）
      const groupTagIds = groupTags.map(function (tag) { return tag.id; });
      const keptExcludes = (cond && Array.isArray(cond.excludeTags) ? cond.excludeTags : []).filter(function (id) {
        return !groupTagIds.includes(id);
      });
      const baseCond = Object.assign({}, cond, { tags: copiedTags, excludeTags: keptExcludes });
      const baseEntries = filterEntries(entries, baseCond);

      for (let t = 0; t < groupTags.length; t++) {
        const tag = groupTags[t];
        let count = 0;
        for (let e = 0; e < baseEntries.length; e++) {
          const entry = baseEntries[e];
          if (entry.tags && entry.tags.includes(tag.id)) {
            count++;
          }
        }
        result[tag.id] = count;
      }
    }

    return result;
  }

  /**
   * 各タイプを単独で選んだ場合の対象姿数を計算します。
   *
   * @param {Array<object>} entries - 全エントリの配列
   * @param {object} cond - 現在の検索条件
   * @param {Array<string>} types - タイプ名の一覧
   * @returns {Object.<string, number>} { タイプ名: 姿数 }
   */
  function typeCounts(entries, cond, types) {
    const result = {};
    if (!Array.isArray(types) || types.length === 0) {
      return result;
    }

    const baseCond = Object.assign({}, cond, { types: [] });
    const baseEntries = filterEntries(entries, baseCond);

    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      let count = 0;
      for (let e = 0; e < baseEntries.length; e++) {
        const entry = baseEntries[e];
        if (entry.types && entry.types.includes(t)) {
          count++;
        }
      }
      result[t] = count;
    }

    return result;
  }

  /**
   * 2つの種族値オブジェクトの 6項目（H, A, B, C, D, S）がすべて等しいか判定します。
   *
   * @param {object|null|undefined} a - 種族値オブジェクト A
   * @param {object|null|undefined} b - 種族値オブジェクト B
   * @returns {boolean} すべて同じ数値なら true、どちらかが不正なら false
   */
  function sameStats(a, b) {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") {
      return false;
    }
    const keys = ["H", "A", "B", "C", "D", "S"];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const valA = a[k];
      const valB = b[k];
      if (typeof valA !== "number" || typeof valB !== "number" || Number.isNaN(valA) || Number.isNaN(valB) || valA !== valB) {
        return false;
      }
    }
    return true;
  }

  /**
   * 入力語から予測変換候補を生成します。
   *
   * @param {object|Array<object>} index - 検索インデックス（items 配列またはインデックスオブジェクト）
   * @param {Array<object>} entries - 全エントリの配列
   * @param {object} cond - 現在の検索条件
   * @param {string} query - 入力語
   * @param {number} [limit=10] - 候補総数の上限
   * @returns {{ groups: Array<object>, shown: number, more: number }}
   */
  function suggest(index, entries, cond, query, limit) {
    const normQuery = normalizeText(query);
    const dexNum = parseDexNumber(query);

    if (normQuery === "" && dexNum === null) {
      return {
        groups: [],
        shown: 0,
        more: 0,
      };
    }

    const items = Array.isArray(index)
      ? index
      : (index && Array.isArray(index.items) ? index.items : []);

    const candidates = [];

    // 全国番号候補（該当する代表エントリがある場合のみ）
    if (dexNum !== null && Array.isArray(entries)) {
      let repEntry = null;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].no === dexNum && entries[i].rep === true) {
          repEntry = entries[i];
          break;
        }
      }
      if (repEntry) {
        const padNo = String(dexNum).padStart(4, "0");
        candidates.push({
          kind: "number",
          ref: dexNum,
          label: "No." + padNo + " " + (repEntry.species || ""),
          sub: "",
          no: dexNum,
          rank: 0,
        });
      }
    }

    // インデックス項目の照合
    if (normQuery !== "") {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || !Array.isArray(item.keys)) continue;

        let bestRank = Infinity;
        for (let k = 0; k < item.keys.length; k++) {
          const keyPair = item.keys[k];
          if (!Array.isArray(keyPair) || keyPair.length < 2) continue;
          const keyStr = keyPair[0];
          const keyKind = keyPair[1];
          if (typeof keyStr !== "string") continue;

          if (keyKind === "name" && keyStr.startsWith(normQuery)) {
            if (1 < bestRank) bestRank = 1;
          } else if (keyKind === "form" && keyStr.startsWith(normQuery)) {
            if (2 < bestRank) bestRank = 2;
          } else if ((keyKind === "name" || keyKind === "form") && keyStr.includes(normQuery)) {
            if (3 < bestRank) bestRank = 3;
          } else if (keyKind === "en" && keyStr.includes(normQuery)) {
            if (4 < bestRank) bestRank = 4;
          } else if (keyKind === "alias" && keyStr.includes(normQuery)) {
            if (5 < bestRank) bestRank = 5;
          }
        }

        if (bestRank !== Infinity) {
          candidates.push({
            kind: item.kind,
            ref: item.ref,
            label: item.label,
            sub: item.sub || "",
            no: typeof item.no === "number" ? item.no : 0,
            rank: bestRank,
            group: item.group || "",
          });
        }
      }
    }

    // 並び順: 順位区分昇順 -> no 昇順 -> label 文字コード順
    candidates.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.no !== b.no) return a.no - b.no;
      if (a.label < b.label) return -1;
      if (a.label > b.label) return 1;
      return 0;
    });

    const total = candidates.length;
    const effectiveLimit = typeof limit === "number" && limit >= 0 ? limit : 10;
    const sliced = candidates.slice(0, effectiveLimit);
    const shown = sliced.length;
    const more = total - shown;

    // 各候補の count と img を計算
    for (let i = 0; i < sliced.length; i++) {
      const cand = sliced[i];

      const countCond = Object.assign({}, cond, {
        text: "",
        speciesNo: null,
        entryId: null,
      });

      if (cand.kind === "number" || cand.kind === "species") {
        countCond.speciesNo = cand.ref;
      } else if (cand.kind === "entry") {
        countCond.entryId = cand.ref;
      } else if (cand.kind === "tag") {
        const newTags = {};
        if (cond && cond.tags && typeof cond.tags === "object") {
          const tagKeys = Object.keys(cond.tags);
          for (let j = 0; j < tagKeys.length; j++) {
            const tk = tagKeys[j];
            if (Array.isArray(cond.tags[tk])) {
              newTags[tk] = cond.tags[tk].slice();
            }
          }
        }
        newTags[cand.group || ""] = [cand.ref];
        countCond.tags = newTags;
      } else if (cand.kind === "type") {
        countCond.types = [cand.ref];
      }

      cand.count = filterEntries(entries, countCond).length;

      if (cand.kind === "entry" && Array.isArray(entries)) {
        let targetEntry = null;
        for (let e = 0; e < entries.length; e++) {
          if (entries[e].id === cand.ref) {
            targetEntry = entries[e];
            break;
          }
        }
        cand.img = targetEntry && targetEntry.img ? targetEntry.img : null;
      }
    }

    const GROUP_DEFS = [
      { kind: "number", title: "全国番号" },
      { kind: "species", title: "ポケモン" },
      { kind: "entry", title: "姿" },
      { kind: "tag", title: "タグ" },
      { kind: "type", title: "タイプ" },
    ];

    const groups = [];
    for (let d = 0; d < GROUP_DEFS.length; d++) {
      const def = GROUP_DEFS[d];
      const groupItems = [];
      for (let s = 0; s < sliced.length; s++) {
        const cand = sliced[s];
        if (cand.kind === def.kind) {
          const itemObj = {
            kind: cand.kind,
            ref: cand.ref,
            label: cand.label,
            sub: cand.sub,
            count: cand.count,
            rank: cand.rank,
          };
          if (cand.kind === "entry") {
            itemObj.img = cand.img !== undefined ? cand.img : null;
          }
          groupItems.push(itemObj);
        }
      }
      if (groupItems.length > 0) {
        groups.push({
          kind: def.kind,
          title: def.title,
          items: groupItems,
        });
      }
    }

    return {
      groups: groups,
      shown: shown,
      more: more,
    };
  }

  /**
   * 表の表示行リストを構築します。
   *
   * @param {Array<object>} entries - 全エントリの配列
   * @param {Array<object>} matched - 条件に一致したエントリの配列
   * @param {object} view - 表示状態（{ filtering, allForms, open }）
   * @returns {Array<object>} 表示行オブジェクトの配列
   */
  function buildRows(entries, matched, view) {
    if (!Array.isArray(entries)) {
      return [];
    }
    const matchedArr = Array.isArray(matched) ? matched : [];

    const matchedSet = new Set();
    for (let i = 0; i < matchedArr.length; i++) {
      const m = matchedArr[i];
      if (m) {
        matchedSet.add(m);
        if (m.id) {
          matchedSet.add(m.id);
        }
      }
    }

    function isMatched(entry) {
      if (!entry) return false;
      return matchedSet.has(entry) || (entry.id && matchedSet.has(entry.id));
    }

    // entries を種ごとにグループ化（元の順序を維持）
    const speciesMap = new Map();
    const speciesList = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (!speciesMap.has(e.no)) {
        const sp = { no: e.no, rep: null, children: [] };
        speciesMap.set(e.no, sp);
        speciesList.push(sp);
      }
      const sp = speciesMap.get(e.no);
      if (e.rep === true) {
        sp.rep = e;
      } else {
        sp.children.push(e);
      }
    }

    function shouldBlankStats(child, rep) {
      if (!child || !rep) return false;
      if (rep.statsState !== "ok" || child.statsState !== "ok") {
        return false;
      }
      return sameStats(child.stats, rep.stats);
    }

    const isFilteringView = Boolean(view && view.filtering);
    const rows = [];

    for (let s = 0; s < speciesList.length; s++) {
      const sp = speciesList[s];
      const rep = sp.rep;
      if (!rep) continue;

      const repMatched = isMatched(rep);
      const matchedChildren = [];
      for (let c = 0; c < sp.children.length; c++) {
        if (isMatched(sp.children[c])) {
          matchedChildren.push(sp.children[c]);
        }
      }

      if (!isFilteringView) {
        // 絞り込みなし
        if (!repMatched) {
          continue;
        }

        const childCount = matchedChildren.length;
        let reviewCount = 0;
        for (let c = 0; c < matchedChildren.length; c++) {
          if (matchedChildren[c].status === "needs_review") {
            reviewCount++;
          }
        }
        const expandable = childCount > 0;

        let expanded = false;
        let forced = false;

        if (view && view.allForms) {
          if (expandable) {
            expanded = true;
            forced = true;
          }
        } else {
          if (view && view.open && view.open.has(rep.no) && expandable) {
            expanded = true;
            forced = false;
          }
        }

        rows.push({
          entry: rep,
          role: "parent",
          matched: true,
          heading: false,
          expandable: expandable,
          expanded: expanded,
          forced: forced,
          childCount: childCount,
          reviewCount: reviewCount,
          blankStats: false,
        });

        if (expanded) {
          for (let c = 0; c < matchedChildren.length; c++) {
            const child = matchedChildren[c];
            rows.push({
              entry: child,
              role: "child",
              matched: true,
              heading: false,
              expandable: false,
              expanded: false,
              forced: false,
              childCount: 0,
              reviewCount: 0,
              blankStats: shouldBlankStats(child, rep),
            });
          }
        }
      } else {
        // 絞り込み中
        if (!repMatched && matchedChildren.length === 0) {
          continue;
        }

        const childCount = matchedChildren.length;
        let reviewCount = 0;
        for (let c = 0; c < matchedChildren.length; c++) {
          if (matchedChildren[c].status === "needs_review") {
            reviewCount++;
          }
        }

        const hasMatchedChildren = childCount > 0;
        const expandable = hasMatchedChildren;
        const expanded = hasMatchedChildren;
        const forced = true;
        const heading = !repMatched;
        const matchedProp = repMatched;

        rows.push({
          entry: rep,
          role: "parent",
          matched: matchedProp,
          heading: heading,
          expandable: expandable,
          expanded: expanded,
          forced: forced,
          childCount: childCount,
          reviewCount: reviewCount,
          blankStats: false,
        });

        if (expanded) {
          for (let c = 0; c < matchedChildren.length; c++) {
            const child = matchedChildren[c];
            rows.push({
              entry: child,
              role: "child",
              matched: true,
              heading: false,
              expandable: false,
              expanded: false,
              forced: false,
              childCount: 0,
              reviewCount: 0,
              blankStats: shouldBlankStats(child, rep),
            });
          }
        }
      }
    }

    return rows;
  }

  const DexCore = {
    normalizeText: normalizeText,
    parseDexNumber: parseDexNumber,
    createCondition: createCondition,
    isFiltering: isFiltering,
    filterEntries: filterEntries,
    summarize: summarize,
    facetCounts: facetCounts,
    typeCounts: typeCounts,
    suggest: suggest,
    sameStats: sameStats,
    buildRows: buildRows,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DexCore;
  } else {
    globalThis.DexCore = DexCore;
  }
})();
