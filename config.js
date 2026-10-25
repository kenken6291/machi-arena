// まちアリーナ～リアルに遊ぶ 設定ファイル
// GitHub に公開される前提のため、秘密情報はここに書かないでください。

export const CONFIG = {
  APP_NAME: 'まちアリーナ～リアルに遊ぶ',
  APP_VERSION: 'v1.0.3',

  // デプロイした GAS Web アプリの URL（…/exec）
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbx6lmMss5gvFhLayveESPPL3Ead0Thlnft86CNFo1Y7cKLibYQQ94i3IGWtlBNebwCYiQ/exec',

  // Gemini API キーはフロントに置かず、GAS のスクリプトプロパティ GEMINI_API_KEY で管理します。
  // この値は空のままにしてください（アプリからは参照しません）。
  GEMINI_API_KEY: '',
  USE_GAS_PROXY_FOR_GEMINI: true,

  // デバッグログ（コンソールに API 通信内容を出力）
  DEBUG_MODE: false,

  // 位置同期の間隔（ミリ秒）。短くするほど GAS の実行回数が増えます
  POLL_INTERVAL_MS: 5000,

  // 音声: 'gemini'（Gemini TTS）/ 'browser'（端末の読み上げ）/ 'off'
  TTS_ENGINE: 'gemini',

  // 地図タイル（OpenStreetMap）
  MAP_TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  MAP_ATTRIBUTION: '&copy; OpenStreetMap contributors',
  DEFAULT_CENTER: [35.681236, 139.767125],
  DEFAULT_ZOOM: 17,

  // localStorage のキー
  STORAGE_KEY: 'machiArena.session',
  ROOM_KEY: 'machiArena.room'
};
