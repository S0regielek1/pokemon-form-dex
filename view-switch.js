/* 表示の切り替え（カード ⇔ 一覧）。
   切り替えるときに、いまの検索条件（文字・タイプ・タグ・全姿表示など）を次のページへ引き継ぐ。
   引き継ぎには window.name を使う（同じタブ内の移動なら file:// でも消えず、保存の許可も要らない）。
   各画面側（app.js / v2.js）が window.DexApp.exportCondition / importCondition を用意している。 */
(function () {
  "use strict";
  const PREFIX = "dexview:";
  const api = window.DexApp;

  // 読み込み時: 前の画面から条件が届いていれば復元する
  try {
    if (typeof window.name === "string" && window.name.indexOf(PREFIX) === 0) {
      const saved = JSON.parse(window.name.slice(PREFIX.length));
      window.name = "";
      if (api && typeof api.importCondition === "function") api.importCondition(saved);
    }
  } catch (e) { window.name = ""; /* 壊れていたら引き継がずに通常表示 */ }

  // 切り替えボタンを押したとき: いまの条件を window.name に預けてから移動する
  document.querySelectorAll(".view-switch a").forEach((link) => {
    link.addEventListener("click", () => {
      try {
        if (api && typeof api.exportCondition === "function") {
          window.name = PREFIX + JSON.stringify(api.exportCondition());
        }
      } catch (e) { /* 預けられなくても移動はできる */ }
    });
  });
})();
