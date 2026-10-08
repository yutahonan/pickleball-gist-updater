/**
 * GitHub Actions 用 Gist アップデーター (stealth 版)
 * playwright-extra + stealth plugin で Cloudflare を回避しながら
 * reserva.be の空き情報を取得して Gist へ保存する。
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const GIST_ID = process.env.RESERVA_GIST_ID || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const SHIMBASHI_SLUG = 'pboneginza';
const TOWER_BOOKING_URL = 'https://reserva.be/tokyotowerpickleball/reserve?mode=service_staff&search_evt_no=42eJwzNDQzNTUDAAQ4ATk';
const EXPORT_DAYS = 30;

function jstDateStr(d = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00+09:00');
  d.setUTCDate(d.getUTCDate() + n);
  return jstDateStr(d);
}

async function updateGist(files: Record<string, string>): Promise<void> {
  if (!GIST_ID || !GITHUB_TOKEN) throw new Error('GITHUB_TOKEN / RESERVA_GIST_ID が未設定です');
  const body = JSON.stringify({
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
  });
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pickleball-booker/1.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`Gist update failed: ${res.status} ${await res.text().then(t => t.slice(0, 120))}`);
  console.log('  Gist 更新完了');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const today = jstDateStr();
  const files: Record<string, string> = {};
  const shimbashiDates: string[] = [];
  const towerMonths: string[] = [];

  // ──────────────────────────────────────────
  // PB1新橋
  // ──────────────────────────────────────────
  console.log(`\n[PB1新橋] HTML取得開始 (${EXPORT_DAYS}日分)`);
  const shimCtx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.9' },
  });
  const shimPage = await shimCtx.newPage();
  const availBase = `https://reserva.be/${SHIMBASHI_SLUG}/availability`;

  try {
    const firstStamp = today.replace(/-/g, '');
    await shimPage.goto(
      `${availBase}?bus_front_availability_date=${firstStamp}&bus_front_availability_time_from=6&bus_front_availability_time_to=23`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // CF チャレンジ解決を含めて最大60秒待機
    try {
      await shimPage.waitForSelector('input[name="bus_front_availability_date"]', { timeout: 60000 });
      console.log('  カレンダー読み込み完了');
    } catch {
      console.warn('  [PB1新橋] カレンダー読み込み失敗（CF チャレンジ未解決）→ スキップ');
    }

    if (shimPage.url().includes('/login') || shimPage.url().includes('id-sso.reserva.be')) {
      console.warn('  [PB1新橋] ログインページへリダイレクト → スキップ');
    } else {
      // 1日目: goto で CF clearance クッキーを取得してからコンテンツを読む
      // 2日目以降: page.evaluate の fetch() で同一セッション内取得（goto は CF 再チャレンジを誘発するため使わない）
      for (let i = 0; i < EXPORT_DAYS; i++) {
        const date = addDays(today, i);
        const stamp = date.replace(/-/g, '');
        const url = `${availBase}?bus_front_availability_date=${stamp}&bus_front_availability_time_from=6&bus_front_availability_time_to=23`;

        try {
          let html: string;
          if (i === 0) {
            html = await shimPage.content();
          } else {
            // ページ内 fetch — CF clearance クッキーが自動で付与される
            html = await shimPage.evaluate(async (fetchUrl: string): Promise<string> => {
              const r = await fetch(fetchUrl, { method: 'GET', credentials: 'same-origin', headers: { 'Accept-Language': 'ja,en;q=0.9' } });
              return r.text();
            }, url);
          }

          if (!html.includes(`name="bus_front_availability_date"`)) {
            const preview = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
            console.warn(`  [${date}] カレンダーなし → スキップ (preview: ${preview})`);
            continue;
          }
          files[`shimbashi_${stamp}.html`] = html;
          shimbashiDates.push(date);
          console.log(`  ${date} OK (${html.length} bytes)`);
        } catch (e: any) {
          console.warn(`  [${date}] 取得失敗: ${e.message}`);
        }
      }
    }
  } finally {
    await shimPage.close();
    await shimCtx.close();
  }

  // ──────────────────────────────────────────
  // 東京タワー
  // ──────────────────────────────────────────
  console.log('\n[東京タワー] AjaxSearch JSON取得開始');
  const uniqueMonths = new Set<string>();
  for (let i = 0; i < EXPORT_DAYS; i++) uniqueMonths.add(addDays(today, i).slice(0, 7));

  const towerCtx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.9' },
  });
  const towerPage = await towerCtx.newPage();

  try {
    await towerPage.goto(TOWER_BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await towerPage.waitForSelector('#reserve_bus_cd', { timeout: 20000 });
    } catch {
      console.warn('  [東京タワー] ページ読み込み失敗 → スキップ');
    }

    if (towerPage.url().includes('/login') || towerPage.url().includes('id-sso.reserva.be')) {
      console.warn('  [東京タワー] ログインページへリダイレクト → スキップ');
    } else {
      for (const month of uniqueMonths) {
        const targetDate = month.replace('-', '/') + '/01';
        const stamp = month.replace('-', '');
        try {
          const calText = await towerPage.evaluate(async (td: string): Promise<string> => {
            const params = new URLSearchParams({
              cmd: 'get_new_institution',
              reserve_bus_cd: '341125',
              reserve_ist_no: '116556',
              target_date: td,
              mode: '',
              month_week: 'month',
              datetime_max_days: '1',
              select_timeorday: '1',
              price_type_no: '0',
            });
            const r = await fetch('/AjaxSearch', {
              method: 'POST',
              headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params.toString(),
            });
            return r.text();
          }, targetDate);

          if (!calText || calText.length < 10) {
            console.warn(`  [${month}] 空レスポンス → スキップ`);
            continue;
          }
          JSON.parse(calText);
          files[`tower_${stamp}.json`] = calText;
          towerMonths.push(month);
          console.log(`  ${month} OK (${calText.length} bytes)`);
        } catch (e: any) {
          console.warn(`  [${month}] 取得失敗: ${e.message}`);
        }
      }
    }
  } finally {
    await towerPage.close();
    await towerCtx.close();
  }

  await browser.close();

  // ──────────────────────────────────────────
  // THE PICKLE BANG THEORY (labola.jp)
  // ──────────────────────────────────────────
  console.log(`\n[PBT] HTML取得開始 (${EXPORT_DAYS}日分)`);
  const LABOLA_SHOP = '3473';
  const LABOLA_TAB = encodeURIComponent('ピックルボールコート');
  const LABOLA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const labolaDates: string[] = [];

  for (let i = 0; i < EXPORT_DAYS; i++) {
    const date = addDays(today, i);
    const [y, mo, d] = date.split('-');
    const url = `https://yoyaku.labola.jp/r/shop/${LABOLA_SHOP}/calendar/${y}/${Number(mo)}/${Number(d)}/?tab_name=${LABOLA_TAB}`;
    const stamp = date.replace(/-/g, '');

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': LABOLA_UA,
          'Accept-Language': 'ja-JP,ja;q=0.9',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.warn(`  [${date}] HTTP ${res.status} → スキップ`);
        continue;
      }

      const html = await res.text();
      if (!html.includes(`/shop/${LABOLA_SHOP}/`)) {
        console.warn(`  [${date}] カレンダー確認できず → スキップ`);
        continue;
      }

      files[`labola_${stamp}.html`] = html;
      labolaDates.push(date);
      console.log(`  ${date} OK (${html.length} bytes)`);
    } catch (e: any) {
      console.warn(`  [${date}] 取得失敗: ${e.message}`);
    }
  }

  files['metadata.json'] = JSON.stringify({
    updatedAt: new Date().toISOString(),
    shimbashiDates,
    towerMonths,
    labolaDates,
  });

  console.log(`\n取得結果: 新橋 ${shimbashiDates.length}日 / タワー ${towerMonths.length}ヶ月 / PBT ${labolaDates.length}日`);
  await updateGist(files);
  console.log('完了');
})().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
