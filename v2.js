// 姿違い対応ポケモン図鑑 v2「標本帖」の画面。
// 絞り込み・集計・候補の計算は lib/dexcore.js（純関数）に任せ、ここでは状態の保持と描画だけを行う。
// 旧デザイン（index.html / app.js）とは独立しており、同じデータ・画像・dexcore.js を共用する。
(function () {
  "use strict";

  const data = window.DEX_DATA;
  const searchIndex = window.DEX_SEARCH_INDEX;
  const core = window.DexCore;
  const $ = (id) => document.getElementById(id);

  if (!data || !searchIndex || !core) {
    const error = $("error");
    error.hidden = false;
    error.textContent = "データを読み込めませんでした。data/generated/dex-data.js と search-index.js があるか確認してください。";
    $("summary-main").textContent = "";
    return;
  }

  const UNKNOWN_IMAGE = "assets/unknown.png";
  const STAT_KEYS = data.meta.statKeys;
  const STAT_LABELS = { H: "HP", A: "こうげき", B: "ぼうぎょ", C: "とくこう", D: "とくぼう", S: "すばやさ" };
  const STAT_MAX = 255;
  const CHUNK = 96;            // 一度に描画するカード数
  const SUGGEST_LIMIT = 10;
  const COMPOSE_GUARD_MS = 30;
  const TYPE_CLASS = {
    "ノーマル": "normal", "ほのお": "fire", "みず": "water", "でんき": "electric", "くさ": "grass",
    "こおり": "ice", "かくとう": "fighting", "どく": "poison", "じめん": "ground", "ひこう": "flying",
    "エスパー": "psychic", "むし": "bug", "いわ": "rock", "ゴースト": "ghost", "ドラゴン": "dragon",
    "あく": "dark", "はがね": "steel", "フェアリー": "fairy",
  };
  const QUIET_TAGS = new Set(["rep", "included", "variant", "battleonly"]);
  const IMAGE_STATE_LABEL = { confirmed: "対応確認済み", substitute: "代用（原種の画像）", none: "なし（要確認）", absent: "なし（取得元に画像が無い）" };
  // 姿の一覧で見出しを付ける系統の優先順（先に挙げた系統のタグを持つ姿は、その見出しに入る）。
  const SECTION_GROUPS = ["change", "region", "attr", "gender", "usage"];

  const entries = data.entries;
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const tagById = new Map(data.tags.map((tag) => [tag.id, tag]));
  const usedTags = new Set();
  entries.forEach((entry) => entry.tags.forEach((tagId) => usedTags.add(tagId)));
  const hasReview = entries.some((entry) => entry.status === "needs_review");
  const hasStatusFlags = hasReview || usedTags.has("img_check") || usedTags.has("name_check");
  $("show-review").parentElement.hidden = !hasReview;

  // 種ごとの姿の一覧（代表が先頭）。
  const family = new Map();
  entries.forEach((entry) => {
    if (!family.has(entry.no)) family.set(entry.no, []);
    family.get(entry.no).push(entry);
  });
  family.forEach((list) => list.sort((a, b) => (b.rep === true) - (a.rep === true)));

  const state = {
    cond: core.createCondition(),
    condLabel: "",
    allForms: false,
    matched: [],
    matchedIds: new Set(),
    list: [],               // 画面に並べるエントリ全件
    shown: 0,               // そのうち描画済みの件数
    suggestion: null,
    flatItems: [],
    activeIndex: -1,
    composing: false,
    composedAt: 0,
    plateId: null,
    lastFocus: null,
  };

  const input = $("search-input");

  // スマホ幅では検索欄の例を短くする（長い例は途中で切れるため）。短い例は HTML の data-placeholder-short に書く。
  const placeholderLong = input.getAttribute("placeholder");
  const placeholderShort = input.dataset.placeholderShort;
  if (placeholderShort) {
    const narrowScreen = window.matchMedia("(max-width: 720px)");
    const applyPlaceholder = () => input.setAttribute("placeholder", narrowScreen.matches ? placeholderShort : placeholderLong);
    applyPlaceholder();
    narrowScreen.addEventListener("change", applyPlaceholder);
  }
  const suggestList = $("suggest-list");
  const grid = $("grid");

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
    ));
  }

  function pad(no) { return String(no).padStart(4, "0"); }

  // 画像ごとの「描かれている範囲」（scripts/make_sprite_bounds.py が作る）。無ければ余白ごと表示する。
  const spriteBounds = window.DEX_SPRITE_BOUNDS || {};

  /**
   * スプライトの <img> を作る。範囲が分かる画像は、余白を切り落として台紙いっぱいに（最大 scale 倍まで）表示する。
   * 切り落としは CSS の object-view-box（Chrome 104+）で行い、非対応のブラウザでは余白ごとの表示になる。
   */
  function spriteTag(entry, className, scale) {
    const src = entry.img || UNKNOWN_IMAGE;
    const box = spriteBounds[src.split("/").pop()];
    const cls = className || "sprite";
    if (!box || cls !== "sprite") {
      return `<img class="${cls}" loading="lazy" src="${escapeHtml(src)}" alt="" data-fallback="1">`;
    }
    const [left, top, right, bottom, width, height] = box;
    const style = `--w:${right - left};--h:${bottom - top};--k:${scale || 4};`
      + `--t:${top}px;--r:${width - right}px;--b:${height - bottom}px;--l:${left}px`;
    return `<img class="sprite crop" loading="lazy" src="${escapeHtml(src)}" alt="" data-fallback="1" style="${style}">`;
  }

  // 画像が読めないときは不明画像に差し替える（レイアウトは崩さない）。
  document.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.dataset.fallback === "1") {
      target.dataset.fallback = "0";
      target.src = UNKNOWN_IMAGE;
    }
  }, true);

  // ---------- 明るさの切り替え ----------

  const themeButton = $("theme-toggle");
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeButton.textContent = theme === "dark" ? "紙にもどす" : "夜にする";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#171512" : "#f3eee1");
  }
  let savedTheme = null;
  try { savedTheme = localStorage.getItem("dexv2-theme"); } catch (e) { /* 保存できない環境では毎回自動判定する */ }
  applyTheme(savedTheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  themeButton.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("dexv2-theme", next); } catch (e) { /* 保存できなくても表示は切り替わる */ }
  });

  // ---------- 予測変換 ----------

  function highlight(label, query) {
    const fold = (value) => value.normalize("NFKC").toLowerCase()
      .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
    const needle = fold(query).trim();
    const haystack = fold(label);
    const at = needle && haystack.length === label.length ? haystack.indexOf(needle) : -1;
    if (at < 0) return escapeHtml(label);
    return escapeHtml(label.slice(0, at)) + "<mark>" + escapeHtml(label.slice(at, at + needle.length)) + "</mark>"
      + escapeHtml(label.slice(at + needle.length));
  }

  function closeSuggest() {
    suggestList.hidden = true;
    suggestList.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    state.flatItems = [];
    state.activeIndex = -1;
  }

  function renderSuggest() {
    const query = input.value;
    const result = core.suggest(searchIndex, entries, state.cond, query, SUGGEST_LIMIT);
    state.suggestion = result;
    state.flatItems = [];
    state.activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    if (core.normalizeText(query) === "" && core.parseDexNumber(query) === null) {
      closeSuggest();
      return;
    }
    const parts = [];
    const bestRank = (group) => Math.min(...group.items.map((item) => item.rank));
    const groups = result.groups.slice().sort((a, b) => bestRank(a) - bestRank(b));
    groups.forEach((group) => {
      parts.push(`<div class="suggest-group-title" role="presentation">${escapeHtml(group.title)}</div>`);
      group.items.forEach((item) => {
        const index = state.flatItems.length;
        state.flatItems.push(item);
        const image = item.kind === "entry"
          ? `<img loading="lazy" width="36" height="36" src="${escapeHtml(item.img || UNKNOWN_IMAGE)}" alt="" data-fallback="1">`
          : "";
        const sub = item.sub ? `<span class="suggest-sub">${highlight(item.sub, query)}</span>` : "";
        parts.push(
          `<div class="suggest-item" role="option" id="suggest-${index}" data-index="${index}" aria-selected="false">`
          + `${image}<span class="suggest-text">${highlight(item.label, query)}${sub}</span>`
          + `<span class="suggest-count">${item.count}姿</span></div>`
        );
      });
    });
    if (result.more > 0) {
      parts.push(`<div class="suggest-more" role="presentation">ほか${result.more}件。文字を足すと絞れます。</div>`);
    }
    if (state.flatItems.length === 0) {
      parts.push('<div class="suggest-empty" role="presentation">候補はありません。Enter で、入力した文字を含む姿を検索します。</div>');
    }
    suggestList.innerHTML = parts.join("");
    suggestList.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function setActive(index) {
    const count = state.flatItems.length;
    if (count === 0) return;
    state.activeIndex = (index + count) % count;
    suggestList.querySelectorAll(".suggest-item").forEach((node) => {
      const active = Number(node.dataset.index) === state.activeIndex;
      node.classList.toggle("active", active);
      node.setAttribute("aria-selected", active ? "true" : "false");
      if (active) {
        node.scrollIntoView({ block: "nearest" });
        input.setAttribute("aria-activedescendant", node.id);
      }
    });
  }

  function chooseSuggestion(item) {
    if (item.kind === "species" || item.kind === "number") {
      state.cond.speciesNo = item.ref;
      state.cond.entryId = null;
      state.cond.text = "";
      state.condLabel = item.label;
    } else if (item.kind === "entry") {
      state.cond.entryId = item.ref;
      state.cond.speciesNo = null;
      state.cond.text = "";
      state.condLabel = entryById.get(item.ref).name;
    } else if (item.kind === "tag") {
      const group = tagById.get(item.ref).group;
      const selected = state.cond.tags[group] || [];
      if (!selected.includes(item.ref)) setTagState(item.ref, "include");
    } else if (item.kind === "type") {
      if (!state.cond.types.includes(item.ref)) state.cond.types = state.cond.types.concat(item.ref);
    }
    input.value = "";
    closeSuggest();
    render();
  }

  function commitInput() {
    if (state.activeIndex >= 0) {
      chooseSuggestion(state.flatItems[state.activeIndex]);
      return;
    }
    if (state.flatItems.length > 0) {
      chooseSuggestion(state.flatItems[0]);
      return;
    }
    const text = input.value.trim();
    if (text === "") return;
    state.cond.text = text;
    state.cond.speciesNo = null;
    state.cond.entryId = null;
    state.condLabel = "";
    input.value = "";
    closeSuggest();
    render();
  }

  input.addEventListener("compositionstart", () => { state.composing = true; });
  input.addEventListener("compositionend", () => {
    state.composing = false;
    state.composedAt = performance.now();
    renderSuggest();
  });
  input.addEventListener("input", renderSuggest);
  input.addEventListener("focus", () => { if (input.value) renderSuggest(); });
  input.addEventListener("keydown", (event) => {
    const composing = state.composing || event.isComposing || event.keyCode === 229
      || performance.now() - state.composedAt < COMPOSE_GUARD_MS;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (composing) return;
      if (suggestList.hidden) renderSuggest();
      event.preventDefault();
      if (state.activeIndex < 0) setActive(event.key === "ArrowDown" ? 0 : state.flatItems.length - 1);
      else setActive(state.activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      if (composing) return;
      event.preventDefault();
      commitInput();
    } else if (event.key === "Escape") {
      if (!suggestList.hidden) {
        event.stopPropagation();
        closeSuggest();
      }
    }
  });
  suggestList.addEventListener("mousedown", (event) => event.preventDefault());
  suggestList.addEventListener("click", (event) => {
    const node = event.target.closest(".suggest-item");
    if (node) chooseSuggestion(state.flatItems[Number(node.dataset.index)]);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-box")) closeSuggest();
  });

  // ---------- 条件・タイプ・タグ ----------

  function renderConditions() {
    const chips = [];
    const cond = state.cond;
    if (cond.speciesNo !== null) chips.push({ key: "species", value: "", text: `種: ${state.condLabel}` });
    if (cond.entryId !== null) chips.push({ key: "entry", value: "", text: `姿: ${state.condLabel}` });
    if (cond.text) chips.push({ key: "text", value: "", text: `「${cond.text}」を含む` });
    cond.types.forEach((type) => chips.push({ key: "type", value: type, text: `タイプ: ${type}` }));
    Object.keys(cond.tags).forEach((group) => {
      cond.tags[group].forEach((tagId) => chips.push({ key: "tag", value: tagId, text: tagById.get(tagId).label }));
    });
    cond.excludeTags.forEach((tagId) => chips.push({
      key: "tag", value: tagId, text: `除外: ${tagById.get(tagId).label}`, exclude: true,
    }));
    $("active-conditions").innerHTML = chips.map((chip) => (
      `<span class="cond-chip${chip.exclude ? " exclude" : ""}">${escapeHtml(chip.text)}`
      + `<button type="button" data-clear="${chip.key}" data-value="${escapeHtml(chip.value)}" `
      + `aria-label="${escapeHtml(chip.text)} の条件を外す">×</button></span>`
    )).join("");
  }

  function toggleType(type) {
    state.cond.types = state.cond.types.includes(type)
      ? state.cond.types.filter((value) => value !== type)
      : state.cond.types.concat(type);
  }

  function tagState(tagId) {
    const tag = tagById.get(tagId);
    if ((state.cond.tags[tag.group] || []).includes(tagId)) return "include";
    return state.cond.excludeTags.includes(tagId) ? "exclude" : "off";
  }

  function setTagState(tagId, next) {
    const tag = tagById.get(tagId);
    state.cond.tags[tag.group] = (state.cond.tags[tag.group] || []).filter((value) => value !== tagId);
    state.cond.excludeTags = state.cond.excludeTags.filter((value) => value !== tagId);
    if (next === "include") state.cond.tags[tag.group] = state.cond.tags[tag.group].concat(tagId);
    if (next === "exclude") state.cond.excludeTags = state.cond.excludeTags.concat(tagId);
  }

  function cycleTag(tagId) {
    const order = { off: "include", include: "exclude", exclude: "off" };
    setTagState(tagId, order[tagState(tagId)]);
  }

  $("active-conditions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-clear]");
    if (!button) return;
    const key = button.dataset.clear;
    if (key === "species" || key === "entry") {
      state.cond.speciesNo = null;
      state.cond.entryId = null;
      state.condLabel = "";
    }
    if (key === "text") state.cond.text = "";
    if (key === "type") toggleType(button.dataset.value);
    if (key === "tag") setTagState(button.dataset.value, "off");
    render();
    input.focus();
  });

  function renderFilters() {
    const typeCount = core.typeCounts(entries, state.cond, data.types);
    $("type-chips").innerHTML = data.types.map((type) => {
      const pressed = state.cond.types.includes(type);
      return `<button type="button" class="stamp type-${TYPE_CLASS[type] || "normal"}${typeCount[type] === 0 ? " zero" : ""}" `
        + `data-type="${escapeHtml(type)}" aria-pressed="${pressed}" title="${escapeHtml(type)}（${typeCount[type]}姿）">${escapeHtml(type)}</button>`;
    }).join("");

    // タグの一覧は開いているときだけ作る（閉じている間は計算を省く）。
    if ($("advanced-filters").hidden) return;
    const tagCount = core.facetCounts(entries, state.cond, data.tags);
    $("tag-filters").innerHTML = data.tagGroups.map((group) => {
      const tags = data.tags.filter((tag) => tag.group === group.id && usedTags.has(tag.id));
      if (tags.length === 0 || (group.id === "status" && !hasStatusFlags)) return "";
      const chips = tags.map((tag) => {
        const current = tagState(tag.id);
        const hint = { off: "押すと、このタグで絞り込みます", include: "絞り込み中。もう一度押すと除外します", exclude: "除外中。もう一度押すと解除します" }[current];
        return `<button type="button" class="chip${tagCount[tag.id] === 0 ? " zero" : ""}${current === "exclude" ? " exclude" : ""}" `
          + `data-tag="${tag.id}" aria-pressed="${current === "include"}" title="${hint}" `
          + `aria-label="${escapeHtml(tag.label)}（${hint}）">${current === "exclude" ? "除外 " : ""}${escapeHtml(tag.label)}`
          + `<span class="count">${tagCount[tag.id]}</span></button>`;
      }).join("");
      return `<div class="filter-group"><div class="filter-title">${escapeHtml(group.label)}</div>`
        + `<div class="chips" role="group" aria-label="${escapeHtml(group.label)}で絞り込み">${chips}</div></div>`;
    }).join("");
  }

  $("type-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-type]");
    if (!chip) return;
    toggleType(chip.dataset.type);
    render();
  });
  $("tag-filters").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-tag]");
    if (!chip) return;
    cycleTag(chip.dataset.tag);
    render();
  });
  document.querySelectorAll('input[name="type-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        state.cond.typeMode = radio.value;
        render();
      }
    });
  });
  $("all-forms").addEventListener("change", (event) => { state.allForms = event.target.checked; render(); });
  $("show-review").addEventListener("change", (event) => {
    state.cond.showNeedsReview = event.target.checked;
    render();
  });
  $("open-filters").addEventListener("click", () => {
    const panel = $("advanced-filters");
    panel.hidden = !panel.hidden;
    $("open-filters").setAttribute("aria-expanded", String(!panel.hidden));
    $("open-filters").textContent = panel.hidden ? "タグで絞り込む ▾" : "タグを閉じる ▴";
    renderFilters();
  });

  function resetAll() {
    state.cond = core.createCondition();
    state.condLabel = "";
    state.allForms = false;
    input.value = "";
    $("all-forms").checked = false;
    $("show-review").checked = true;
    document.querySelector('input[name="type-mode"][value="any"]').checked = true;
    closeSuggest();
    render();
  }
  $("reset-all").addEventListener("click", resetAll);
  $("empty-reset").addEventListener("click", resetAll);

  // ---------- カード一覧 ----------

  function typeStamps(types) {
    return types.map((type) => (
      `<span class="stamp type-${TYPE_CLASS[type] || "normal"}">${escapeHtml(type)}</span>`
    )).join("");
  }

  /** 姿違いのカードに添える短い見出し（メガシンカ・アローラ など）。無ければ空文字。 */
  function formBadge(entry) {
    for (const groupId of SECTION_GROUPS) {
      const tagId = entry.tags.find((id) => tagById.has(id) && tagById.get(id).group === groupId && !QUIET_TAGS.has(id));
      if (tagId) {
        const label = tagById.get(tagId).label;
        return `<span class="stamp quiet">${escapeHtml(label)}</span>`;
      }
    }
    return "";
  }

  // 台紙の色に使うタイプ。ふつうは1つ目のタイプ。
  // オーガポンだけは、2つ目のタイプがある姿（いどのめん・かまどのめん・いしずえのめん、各テラスタル）で2つ目を使う。
  // 通常のオーガポンやみどりのめん（テラスタル）は草タイプ1つだけなので、そのまま草の色になる。
  function matTypeOf(entry) {
    if (Number(entry.no) === 1017 && entry.types.length > 1) return entry.types[1];
    return entry.types[0];
  }

  function plateHtml(entry) {
    const siblings = family.get(entry.no) || [entry];
    const others = siblings.filter((item) => item !== entry && !item.rep);
    const isRep = entry.rep === true;
    const title = isRep ? entry.species : entry.name;
    const sub = isRep ? `<em>${escapeHtml(entry.en)}</em>` : escapeHtml(entry.form || entry.en);
    const formsStamp = isRep && others.length > 0 ? `<span class="forms-stamp" aria-label="姿違い${others.length}件"><b>姿</b>×${others.length}</span>` : "";
    const badge = isRep ? "" : formBadge(entry);
    let thumbs = "";
    if (isRep && others.length > 0) {
      const shown = others.slice(0, 5).map((item) => spriteTag(item, "thumb")).join("");
      thumbs = `<div class="thumbs" aria-hidden="true">${shown}${others.length > 5 ? `<span class="more-n">+${others.length - 5}</span>` : ""}</div>`;
    }
    const typeClass = TYPE_CLASS[matTypeOf(entry)] || "normal";   // 台紙の色分け用（コミック風スキンが使う）
    return `<article class="plate t-${typeClass}" data-id="${escapeHtml(entry.id)}">`
      + `<div class="plate-head"><span class="no">No.${pad(entry.no)}</span>${formsStamp}${badge}</div>`
      + `<div class="mat">${spriteTag(entry, "sprite")}</div>`
      + `<h3 class="name"><button type="button" class="plate-open" data-open="${escapeHtml(entry.id)}">${escapeHtml(title)}</button></h3>`
      + `<div class="sub">${sub}</div>`
      + `<div class="types">${typeStamps(entry.types)}</div>`
      + thumbs
      + "</article>";
  }

  function renderChunk() {
    const next = Math.min(state.list.length, state.shown + CHUNK);
    grid.insertAdjacentHTML("beforeend", state.list.slice(state.shown, next).map(plateHtml).join(""));
    state.shown = next;
    $("more").hidden = state.shown >= state.list.length;
  }

  // 末尾が見えたら続きを描画する（IntersectionObserver が無い環境ではボタンで続きを出す）。
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((items) => {
      if (items.some((item) => item.isIntersecting) && state.shown < state.list.length) renderChunk();
    }, { rootMargin: "800px 0px" }).observe($("more"));
  }
  $("more-button").addEventListener("click", renderChunk);

  function renderSummary(filtering) {
    const summary = core.summarize(state.matched);
    if (filtering) {
      $("summary-main").innerHTML = `一致する姿 <strong>${summary.forms}</strong>件（<strong>${summary.species}</strong>種）`
        + (hasReview ? `　採用${summary.included}・要確認${summary.needsReview}` : "");
      $("summary-sub").textContent = "一致した姿を一枚ずつ並べています。カードを開くと、その種の姿違いが並びます。";
    } else if (state.allForms) {
      $("summary-main").innerHTML = `全 <strong>${summary.forms}</strong>姿を並べています`;
      $("summary-sub").textContent = `原種${summary.reps}・追加の姿違い${summary.extras}`;
    } else {
      $("summary-main").innerHTML = `<strong>${summary.species}</strong>種の原種を並べています`;
      $("summary-sub").textContent = `姿違いは ${summary.extras} 件。「姿 ×n」の付いたカードを開くと見られます。`;
    }
  }

  function render() {
    const filtering = core.isFiltering(state.cond);
    state.matched = core.filterEntries(entries, state.cond);
    state.matchedIds = new Set(state.matched.map((entry) => entry.id));
    // 絞り込み中と全姿表示のときは姿を一枚ずつ並べ、それ以外は代表だけを並べる。
    state.list = filtering || state.allForms ? state.matched : state.matched.filter((entry) => entry.rep === true);
    state.shown = 0;
    grid.innerHTML = "";
    renderConditions();
    renderFilters();
    renderSummary(filtering);
    renderChunk();
    // 条件を変えたときは、一覧の先頭が見える位置まで戻す。
    const gridTop = grid.getBoundingClientRect().top + window.scrollY - 200;
    if (window.scrollY > gridTop) window.scrollTo({ top: Math.max(0, gridTop) });
    $("empty").hidden = state.matched.length > 0;
    // 絞り込み中は一致した姿を常に並べるため、全姿表示は切り替えられない（値は保持する）。
    const allForms = $("all-forms");
    allForms.disabled = filtering;
    allForms.parentElement.hidden = false;
    allForms.parentElement.style.opacity = filtering ? ".5" : "";
  }

  grid.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open]");
    if (opener) openPlate(opener.dataset.open, opener);
  });
  // カードのどこを押しても開く（見出しのボタンが全面に広がっているが、サムネイルなどの子要素のクリックも拾う）。
  grid.addEventListener("click", (event) => {
    if (event.target.closest("[data-open]")) return;
    const card = event.target.closest(".plate");
    if (card) openPlate(card.dataset.id, card.querySelector("[data-open]"));
  });

  // ---------- 標本シート（詳細） ----------

  const dialog = $("plate-dialog");

  function sectionTitle(entry) {
    if (entry.rep === true) return "原種";
    for (const groupId of SECTION_GROUPS) {
      const tagId = entry.tags.find((id) => tagById.has(id) && tagById.get(id).group === groupId && !QUIET_TAGS.has(id));
      if (tagId) {
        if (groupId === "region") return "リージョンフォーム";
        if (groupId === "gender") return "性別の違い";
        return tagById.get(tagId).label;
      }
    }
    return "ほかの姿";
  }

  function statRows(entry, rep) {
    if (!entry.stats || entry.statsState !== "ok") {
      const label = entry.statsState === "pending" ? "確認中" : (entry.statsState === "fixed" ? "対象外" : "不明");
      return `<p class="stat-note">種族値: ${label}</p>`;
    }
    const compare = rep && rep !== entry && rep.stats && rep.statsState === "ok" ? rep.stats : null;
    const total = STAT_KEYS.reduce((sum, key) => sum + entry.stats[key], 0);
    const repTotal = compare ? STAT_KEYS.reduce((sum, key) => sum + compare[key], 0) : 0;
    const diffCell = (value) => {
      if (!compare || value === 0) return '<span class="stat-diff"></span>';
      return `<span class="stat-diff ${value > 0 ? "up" : "down"}">${value > 0 ? "+" : "−"}${Math.abs(value)}</span>`;
    };
    const rows = STAT_KEYS.map((key) => {
      const value = entry.stats[key];
      const tick = compare && compare[key] !== value
        ? `<span class="stat-tick" style="left:${Math.min(100, compare[key] / STAT_MAX * 100)}%"></span>` : "";
      return `<li class="stat"><span class="stat-label">${STAT_LABELS[key] || key}</span>`
        + `<span class="stat-bar"><span class="stat-fill" style="width:${Math.min(100, value / STAT_MAX * 100)}%"></span>${tick}</span>`
        + `<span class="stat-num">${value}</span>${diffCell(compare ? value - compare[key] : 0)}</li>`;
    }).join("");
    const totalRow = `<li class="stat stat-total"><span class="stat-label">合計</span><span></span>`
      + `<span class="stat-num">${total}</span>${diffCell(compare ? total - repTotal : 0)}</li>`;
    const notes = [];
    if (compare) notes.push("赤い目盛りは原種の値です。");
    if (entry.converted) notes.push("固定の実数値から換算した種族値相当です。");
    return `<ul class="stats">${rows}${totalRow}</ul>` + (notes.length ? `<p class="stat-note">${notes.join("")}</p>` : "");
  }

  function renderFocus(entry) {
    const siblings = family.get(entry.no) || [entry];
    const rep = siblings.find((item) => item.rep === true) || null;
    const parent = entry.parent ? entryById.get(entry.parent) : null;
    const same = parent && core.sameStats(entry.stats, parent.stats) ? "（原種と同じ種族値）" : "";
    const tagStamps = entry.tags.filter((id) => tagById.has(id) && !QUIET_TAGS.has(id))
      .map((id) => `<span class="stamp quiet">${escapeHtml(tagById.get(id).label)}</span>`).join("");
    const facts = [
      ["姿", `${escapeHtml(entry.form || "（姿名なし）")}${entry.rep ? "／原種" : ""}${same}`],
      parent ? ["原種", escapeHtml(parent.name)] : null,
      entry.fixed ? ["固定の実数値", `Lv.${entry.fixed.level}: ${STAT_KEYS.map((key) => `${key}${entry.fixed.stats[key]}`).join(" ")}（上の値は種族値への換算）`] : null,
      ["特性", escapeHtml(entry.abilities.join("、") || "未取得")],
      tagStamps ? ["タグ", `<div class="tag-stamps">${tagStamps}</div>`] : null,
      entry.status === "needs_review" ? ["状態", "要確認"] : null,
      entry.imgState !== "confirmed" ? ["画像", escapeHtml(IMAGE_STATE_LABEL[entry.imgState] || entry.imgState)] : null,
      ["取得元", escapeHtml(entry.sources.join("、"))],
      ["ID", `<code>${escapeHtml(entry.id)}</code>`],
      entry.notes.length ? ["メモ", escapeHtml(entry.notes.join("／"))] : null,
    ].filter(Boolean);
    $("plate-focus").innerHTML =
      `<div class="mat">${spriteTag(entry, "sprite", 6)}</div>`
      + `<h2 id="plate-title">${escapeHtml(entry.name)}</h2>`
      + `<p class="en"><span class="focus-no">No.${pad(entry.no)}</span>　${escapeHtml(entry.en)}</p>`
      + `<div class="types">${typeStamps(entry.types)}</div>`
      + statRows(entry, rep)
      + `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
    $("sheet-label").textContent = `PLATE  No.${pad(entry.no)}`;
  }

  function renderFamily(entry) {
    const siblings = family.get(entry.no) || [entry];
    const filtering = core.isFiltering(state.cond);
    const sections = new Map();
    siblings.forEach((item) => {
      const title = sectionTitle(item);
      if (!sections.has(title)) sections.set(title, []);
      sections.get(title).push(item);
    });
    // 代表を先頭に、あとは系統の優先順（SECTION_GROUPS）に並べる。
    const rank = (title) => {
      if (title === "原種") return -1;
      if (title === "ほかの姿") return 99;
      const sample = sections.get(title)[0];
      for (let i = 0; i < SECTION_GROUPS.length; i++) {
        if (sample.tags.some((id) => tagById.has(id) && tagById.get(id).group === SECTION_GROUPS[i] && !QUIET_TAGS.has(id))) return i;
      }
      return 98;
    };
    const ordered = Array.from(sections.entries()).sort((a, b) => rank(a[0]) - rank(b[0]));
    const tile = (item) => {
      const label = item.rep ? item.species : (item.form && item.name.includes(item.form) ? item.form : item.name);
      const dim = filtering && !state.matchedIds.has(item.id) ? " dim" : "";
      return `<button type="button" class="tile${dim}" data-pick="${escapeHtml(item.id)}" aria-current="${item.id === entry.id}">`
        + `<span class="mat">${spriteTag(item, "sprite", 2)}</span><span class="tile-name">${escapeHtml(label)}</span></button>`;
    };
    $("plate-family").innerHTML =
      `<h2 class="family-title">${escapeHtml(entry.species)}の姿</h2>`
      + `<p class="family-lead">全${siblings.length}姿。押すと左の標本が切り替わります。</p>`
      + ordered.map(([title, items]) => (
        `<div class="family-section"><h3>${escapeHtml(title)} <span>${items.length}</span></h3>`
        + `<div class="tiles">${items.map(tile).join("")}</div></div>`
      )).join("");
  }

  function showPlate(entryId) {
    const entry = entryById.get(entryId);
    if (!entry) return;
    state.plateId = entryId;
    renderFocus(entry);
    renderFamily(entry);
  }

  function openPlate(entryId, opener) {
    state.lastFocus = opener || null;
    showPlate(entryId);
    if (!dialog.open) dialog.showModal();
    $("plate-focus").scrollTop = 0;
    $("plate-family").scrollTop = 0;
    $("plate-close").focus();
  }

  $("plate-family").addEventListener("click", (event) => {
    const tile = event.target.closest("[data-pick]");
    if (!tile) return;
    const scroll = $("plate-family").scrollTop;
    showPlate(tile.dataset.pick);
    $("plate-family").scrollTop = scroll;
    $("plate-focus").scrollTop = 0;
    const current = $("plate-family").querySelector('[aria-current="true"]');
    if (current) current.focus({ preventScroll: true });
  });
  $("plate-close").addEventListener("click", () => dialog.close());
  // 枠の外（暗い部分）を押したら閉じる。
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    state.plateId = null;
    if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus({ preventScroll: true });
  });

  // ---------- 収録数・フッター ----------

  const counts = data.meta.counts;
  $("count-species").textContent = data.meta.nationalDexMax;
  $("count-forms").textContent = counts.forms;
  $("footer-meta").textContent =
    `データ生成: ${data.meta.generatedAt} ／ 登録されている姿 ${counts.forms}件`
    + (hasReview ? `（採用${counts.included}・要確認${counts.needsReview}）` : "")
    + `・除外${counts.excluded}件・別枠の候補${counts.special}件`;

  // 表示の切り替え（カード⇔一覧）で検索条件を引き継ぐための窓口。view-switch.js が使う。
  window.DexApp = Object.assign(window.DexApp || {}, {
    exportCondition: () => ({ cond: state.cond, condLabel: state.condLabel, allForms: state.allForms }),
    importCondition: (saved) => {
      state.cond = Object.assign(core.createCondition(), saved.cond);
      state.condLabel = saved.condLabel || "";
      state.allForms = Boolean(saved.allForms);
      const radio = document.querySelector('input[name="type-mode"][value="' + state.cond.typeMode + '"]');
      if (radio) radio.checked = true;
      $("show-review").checked = state.cond.showNeedsReview;
      $("all-forms").checked = state.allForms;
      render();
    },
  });
  render();
})();
