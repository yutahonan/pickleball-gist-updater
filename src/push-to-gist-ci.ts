/**
 * GitHub Actions 用 Gist アップデーター
 * playwright-extra + stealth plugin で Cloudflare を回避しながら
 * 8施設の空き情報を取得して Gist へ保存する。
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const GIST_ID = process.env.RESERVA_GIST_ID || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const SHIMBASHI_SLUG = 'pboneginza';
const TOWER_BOOKING_URL = 'https://reserva.be/tokyotowerpickleball/reserve?mode=service_staff&search_evt_no=42eJwzNDQzNTUDAAQ4ATk';
const EXPORT_DAYS = 30;
const LABOLA_DAYS = 14;

const HOLIDAYS = new Set([
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23','2026-03-20',
  '2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-07-20',
  '2026-08-11','2026-09-21','2026-09-22','2026-09-23','2026-10-12',
  '2026-11-03','2026-11-23','2026-12-23',
]);

function isWeekendOrHoliday(d: string): boolean {
  const dt = new Date(d + 'T00:00:00+09:00');
  return dt.getDay() === 0 || dt.getDay() === 6 || HOLIDAYS.has(d);
}

function isTargetHour(h: number, d: string): boolean {
  if (isWeekendOrHoliday(d)) return true;
  return h >= 16;
}

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

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

type Slots = Record<string, string[]>;

function makeSlotFile(name: string, reserveUrl: string, slots: Slots): string {
  return JSON.stringify({ name, reserveUrl, updatedAt: new Date().toISOString(), slots });
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

// ──────────────────────────────────────────────────────────────
// Sansan池袋 (REST API)
// ──────────────────────────────────────────────────────────────
interface Booking { court_id: string; date: string; time: string; duration: number; }
interface Court { id: string; name: string; group_id: string; }
interface FacilityGroup {
  id: string;
  weekday_open_time: string; weekday_close_time: string;
  holiday_open_time: string; holiday_close_time: string;
}
interface AdminBlock { court_id: string; date: string; start_time: string; end_time: string; }
interface EventBlock {
  court_ids: string[];
  schedule_type: string;
  start_time: string; end_time: string;
  start_date: string; end_date: string | null;
  day_of_weeks: number[] | null;
  specific_dates: string[] | null;
}
interface EventSchedule {
  schedule_type: string; time: string; duration: number;
  start_date: string; end_date: string | null;
  day_of_weeks: number[] | null; specific_dates: string[] | null;
}
interface SansanEvent { court_ids: string[]; schedules: EventSchedule[]; }

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function isOverlapping(start: number, dur: number, booked: [number, number][]): boolean {
  const end = start + dur * 60;
  return booked.some(([bs, be]) => start < be && end > bs);
}

function scheduleAppliesToDate(
  s: { schedule_type: string; start_date: string; end_date: string | null; day_of_weeks: number[] | null; specific_dates: string[] | null },
  date: string
): boolean {
  const dow = new Date(date + 'T00:00:00+09:00').getDay();
  switch (s.schedule_type) {
    case 'date': return s.start_date === date;
    case 'weekly':
      if (date < s.start_date) return false;
      if (s.end_date && date > s.end_date) return false;
      return (s.day_of_weeks ?? []).includes(dow);
    case 'specific_dates': return (s.specific_dates ?? []).includes(date);
    case 'period': return date >= s.start_date && (!s.end_date || date <= s.end_date);
    default: return false;
  }
}

async function fetchSansanSlots(today: string, startDayOffset: number): Promise<Slots> {
  const base = 'https://reserve.sansan-pickleball.com/api';
  const FACILITY_ID = 'f1';
  const [bookings, courts, groups, adminBlocks, eventBlocks, events] = await Promise.all([
    fetch(`${base}/bookings/availability?facilityId=${FACILITY_ID}`).then(r => r.json()),
    fetch(`${base}/public/courts?facilityId=${FACILITY_ID}`).then(r => r.json()),
    fetch(`${base}/public/facility-groups?facilityId=${FACILITY_ID}`).then(r => r.json()),
    fetch(`${base}/public/admin-blocks?facilityId=${FACILITY_ID}`).then(r => r.json()),
    fetch(`${base}/public/event-blocks?facilityId=${FACILITY_ID}`).then(r => r.json()),
    fetch(`${base}/public/events?facilityId=${FACILITY_ID}`).then(r => r.json()),
  ]) as [Booking[], Court[], FacilityGroup[], AdminBlock[], EventBlock[], SansanEvent[]];

  const dates: string[] = [];
  for (let i = startDayOffset; i < 60; i++) dates.push(addDays(today, i));

  const groupMap = new Map(groups.map((g: FacilityGroup) => [g.id, g]));
  const result: Slots = {};

  for (const date of dates) {
    const isHoliday = isWeekendOrHoliday(date);
    for (const court of courts) {
      const group = groupMap.get(court.group_id);
      if (!group) continue;
      const openHour  = timeToMin(isHoliday ? group.holiday_open_time  : group.weekday_open_time)  / 60;
      const closeHour = timeToMin(isHoliday ? group.holiday_close_time : group.weekday_close_time) / 60;
      const booked: [number, number][] = [];
      bookings.filter((b: Booking) => b.court_id === court.id && b.date === date)
              .forEach((b: Booking) => booked.push([timeToMin(b.time), timeToMin(b.time) + b.duration * 60]));
      adminBlocks.filter((b: AdminBlock) => b.court_id === court.id && b.date === date)
                 .forEach((b: AdminBlock) => booked.push([timeToMin(b.start_time), timeToMin(b.end_time)]));
      eventBlocks.filter((b: EventBlock) => b.court_ids.includes(court.id) && scheduleAppliesToDate(b, date))
                 .forEach((b: EventBlock) => booked.push([timeToMin(b.start_time), timeToMin(b.end_time)]));
      for (const ev of events as SansanEvent[]) {
        if (!ev.court_ids.includes(court.id)) continue;
        for (const s of ev.schedules ?? []) {
          if (!scheduleAppliesToDate(s, date)) continue;
          const start = timeToMin(s.time);
          booked.push([start, start + s.duration * 60]);
        }
      }
      for (let h = openHour; h < closeHour; h++) {
        if (!isTargetHour(h, date)) continue;
        let maxDur = 0;
        for (const dur of [3, 2]) {
          if (h + dur > closeHour) continue;
          if (!isOverlapping(h * 60, dur, booked)) { maxDur = dur; break; }
        }
        if (maxDur === 0) continue;
        for (let offset = 0; offset < maxDur; offset++) {
          const key = `${date}|${h + offset}`;
          if (!result[key]) result[key] = [];
          if (!result[key].includes(court.name)) result[key].push(court.name);
        }
      }
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// andpickle (REST API)
// ──────────────────────────────────────────────────────────────
async function fetchAndPickleSlots(today: string): Promise<Slots> {
  const BASE_URL = 'https://reserve.andpickle.jp';
  const result: Slots = {};
  for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
    const dateStr = addDays(today, dayOffset);
    try {
      const data: any = await fetch(`${BASE_URL}/api/reserve-data?date=${dateStr}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': `${BASE_URL}/reserve` },
      }).then(r => r.json());
      const rentalCourts = (data.courts ?? []).filter((c: any) => c.primaryUse === 'RENTAL_BASE');
      if (rentalCourts.length === 0) continue;
      const blockedByCourtId = new Map<string, [number, number][]>();
      for (const c of rentalCourts) blockedByCourtId.set(c.id, []);
      for (const r of [...(data.reservations ?? []), ...(data.lessons ?? [])]) {
        if (!blockedByCourtId.has(r.courtId)) continue;
        const start = (new Date(r.startAt).getTime() + 9 * 3600000) / 3600000 % 24;
        const end   = (new Date(r.endAt).getTime()   + 9 * 3600000) / 3600000 % 24;
        blockedByCourtId.get(r.courtId)!.push([start, end === 0 ? 24 : end]);
      }
      for (const court of rentalCourts) {
        const blocked = blockedByCourtId.get(court.id) ?? [];
        for (let h = 9; h < 22; h++) {
          if (!isTargetHour(h, dateStr)) continue;
          if (blocked.some(([s, e]: [number,number]) => s < h + 1 && e > h)) continue;
          const key = `${dateStr}|${h}`;
          if (!result[key]) result[key] = [];
          if (!result[key].includes(court.name)) result[key].push(court.name);
        }
      }
    } catch (e: any) {
      console.warn(`  [andpickle ${dateStr}] ${e.message?.slice(0,60)}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// pickle9 / hacomono (REST API)
// ──────────────────────────────────────────────────────────────
async function fetchPickle9Slots(today: string): Promise<Slots> {
  const BASE_URL = 'https://loun9ine.hacomono.jp';
  const STUDIO_ROOM_ID = 62, PROGRAM_ID = 50, INSTRUCTOR_ID = 24;
  const result: Slots = {};
  for (let week = 0; week < 9; week++) {
    const fromDate = addDays(today, week * 7);
    const toDate   = addDays(today, week * 7 + 6);
    const query = encodeURIComponent(JSON.stringify({
      page: 1, is_all: false, is_flat: false, is_fast: false,
      instructor_ids: [INSTRUCTOR_ID], date_from: fromDate, date_to: toDate,
    }));
    const url = `${BASE_URL}/api/reservation/reservations/choice/reserve-schedule?studio_room_id=${STUDIO_ROOM_ID}&program_id=${PROGRAM_ID}&query=${query}`;
    try {
      const data: any = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': `${BASE_URL}/reserve/schedule/22/62` },
      }).then(r => r.json());
      const schedule = data?.data?.reserve_schedule;
      if (!schedule) continue;
      for (const day of schedule.dates ?? []) {
        for (const slot of day.times ?? []) {
          if (!slot.is_reservable) continue;
          const dt = new Date(slot.start_at);
          const jst = new Date(dt.getTime() + 9 * 3600000);
          const d = new Date(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
          const dateStr = toLocalDateStr(d);
          const hour = jst.getUTCHours();
          if (!isTargetHour(hour, dateStr)) continue;
          const key = `${dateStr}|${hour}`;
          if (!result[key]) result[key] = ['コートレンタル'];
        }
      }
    } catch (e: any) {
      console.warn(`  [pickle9 week${week}] ${e.message?.slice(0,60)}`);
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// PB1豊洲 (Playwright headless)
// ──────────────────────────────────────────────────────────────
const TOYOSU_COURT_NAMES = ['コートA', 'コートB', 'コートC', 'コートD'];
const TOYOSU_COURT_COUNT = 4;

async function fetchToyosuSlots(browser: any, today: string, startDayOffset: number): Promise<Slots> {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });
  const page = await ctx.newPage();
  const result: Slots = {};
  try {
    await page.goto('https://rsv.pickle-one.com/pb1-toyosu/reservations/new/slots?facility=1', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const year = parseInt(today.slice(0, 4), 10);
    const startDateStr = addDays(today, startDayOffset);
    const limitStr = addDays(today, 60);

    for (let week = 0; week < 9; week++) {
      if (week > 0) {
        const nextBtn = page.locator('button[aria-label="次の週"]');
        const disabled = await nextBtn.evaluate((el: HTMLButtonElement) => el.disabled).catch(() => true);
        if (disabled) break;
        await nextBtn.click();
        await page.waitForTimeout(1000);
      }

      const ariaLabel = await page.locator('button[aria-label^="表示期間"]').getAttribute('aria-label').catch(() => '') ?? '';
      const m = ariaLabel.match(/(\d{1,2})\/(\d{1,2})/);
      if (!m) continue;
      const startDate = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
      const weekDates: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
        weekDates.push(toLocalDateStr(d));
      }
      if (weekDates[0] > limitStr) break;

      const rows: { time: string; available: boolean[] }[] = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        const table = tables[1];
        if (!table) return [];
        const out: { time: string; available: boolean[] }[] = [];
        for (const tr of table.querySelectorAll('tr')) {
          const cells = tr.querySelectorAll('td, th');
          if (cells.length < 2) continue;
          const time = (cells[0] as HTMLElement).textContent?.trim() ?? '';
          if (!/^\d{2}:\d{2}$/.test(time)) continue;
          const available: boolean[] = [];
          for (let ci = 1; ci < cells.length; ci++) {
            available.push(!!(cells[ci] as HTMLElement).querySelector('button'));
          }
          out.push({ time, available });
        }
        return out;
      });

      for (const { time, available } of rows) {
        const tm = time.match(/^(\d{2}):00$/);
        if (!tm) continue;
        const hour = parseInt(tm[1], 10);
        for (let ci = 0; ci < available.length; ci++) {
          const dayIdx = Math.floor(ci / TOYOSU_COURT_COUNT);
          const courtIdx = ci % TOYOSU_COURT_COUNT;
          if (dayIdx >= weekDates.length) continue;
          const date = weekDates[dayIdx];
          if (date < startDateStr || date > limitStr) continue;
          if (!isTargetHour(hour, date)) continue;
          if (!available[ci]) continue;
          const key = `${date}|${hour}`;
          if (!result[key]) result[key] = [];
          const courtName = TOYOSU_COURT_NAMES[courtIdx] ?? `コート${courtIdx + 1}`;
          if (!result[key].includes(courtName)) result[key].push(courtName);
        }
      }
    }
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// パシフィック (Playwright headless)
// ──────────────────────────────────────────────────────────────
async function fetchPacificSlots(browser: any, today: string, startDayOffset: number): Promise<Slots> {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });
  const page = await ctx.newPage();
  const result: Slots = {};
  try {
    await page.goto('https://pacificpickleclub.resv.jp/reserve/calendar.php?x=1791040369', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(2000);

    try {
      const isActive = await page.evaluate(() => {
        for (const el of document.querySelectorAll('td, a')) {
          if ((el as HTMLElement).textContent?.includes('コート予約Ver.2')) return el.classList.contains('active');
        }
        return true;
      });
      if (!isActive) {
        await page.locator('td, a').filter({ hasText: 'コート予約Ver.2' }).first().click();
        await page.waitForTimeout(1500);
      }
    } catch {}

    const year = parseInt(today.slice(0, 4), 10);
    const startDateStr = addDays(today, startDayOffset);
    const limitStr = addDays(today, 60);

    for (let week = 0; week < 9; week++) {
      if (week > 0) {
        await page.locator('a').filter({ hasText: '翌週' }).first().click();
        await page.waitForTimeout(2000);
      }

      const tableData: { firstDate: string | null; slotRows: string[][] } | null = await page.evaluate(() => {
        let firstDate: string | null = null;
        let slotRows: string[][] = [];
        for (const tbl of document.querySelectorAll('table')) {
          const firstRow = tbl.querySelector('tr');
          if (!firstRow) continue;
          const cells = Array.from(firstRow.querySelectorAll('td, th'));
          const texts = cells.map(c => (c as HTMLElement).textContent?.trim() ?? '');
          if (!firstDate && texts.some(t => /\d+\/\d+\(/.test(t))) {
            const match = texts.find(t => /\d+\/\d+\(/.test(t))?.match(/(\d{1,2})\/(\d{1,2})\(/);
            if (match) firstDate = `${match[1]}/${match[2]}`;
          }
          if (slotRows.length === 0 && /^\d{2}:\d{2}$/.test(texts[0])) {
            for (const tr of tbl.querySelectorAll('tr')) {
              const cs = Array.from(tr.querySelectorAll('td, th'));
              slotRows.push(cs.map(c => (c as HTMLElement).textContent?.trim() ?? ''));
            }
          }
          if (firstDate && slotRows.length > 0) break;
        }
        return firstDate ? { firstDate, slotRows } : null;
      });

      if (!tableData) continue;
      const [mo, day] = tableData.firstDate!.split('/').map(Number);
      const firstDateStr = `${year}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if (firstDateStr > limitStr) break;

      for (const row of tableData.slotRows) {
        if (row.length < 2) continue;
        const tm = row[0].match(/^(\d{2}):(\d{2})$/);
        if (!tm) continue;
        const hour = parseInt(tm[1], 10);
        for (let ci = 1; ci < row.length; ci++) {
          const cellM = row[ci].match(/(\d{1,2})\/(\d{1,2})\(.*?残数[：:]\s*(\d+)/);
          if (!cellM) continue;
          if (parseInt(cellM[3], 10) <= 0) continue;
          const cmo = parseInt(cellM[1]), cday = parseInt(cellM[2]);
          const date = `${year}-${String(cmo).padStart(2,'0')}-${String(cday).padStart(2,'0')}`;
          if (date < startDateStr || date > limitStr) continue;
          if (!isTargetHour(hour, date)) continue;
          const key = `${date}|${hour}`;
          if (!result[key]) result[key] = ['空き'];
        }
      }
    }
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// Tower slots from week_time_array JSON
// ──────────────────────────────────────────────────────────────
function extractTowerSlots(weekTimeArray: Record<string, any>, today: string, startDayOffset: number): Slots {
  const result: Slots = {};
  const startDateStr = addDays(today, startDayOffset);
  const limitStr = addDays(today, 60);
  for (const [dateStr, dayData] of Object.entries(weekTimeArray)) {
    if (dateStr < startDateStr || dateStr > limitStr) continue;
    if (!dayData?.data) continue;
    for (const slot of dayData.data) {
      if (slot.is_enabled !== 1) continue;
      const match = slot.sttime_view?.match(/^(\d{1,2}):/);
      if (!match) continue;
      const hour = parseInt(match[1], 10);
      if (!isTargetHour(hour, dateStr)) continue;
      const key = `${dateStr}|${hour}`;
      if (!result[key]) result[key] = ['コート空き'];
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });
  const today = jstDateStr();
  const now = new Date().toISOString();
  const files: Record<string, string> = {};
  const shimbashiDates: string[] = [];
  const towerMonths: string[] = [];
  const labolaDates: string[] = [];
  const shimbashiSlots: Slots = {};
  const towerSlots: Slots = {};

  // ──────────────────────────────────────────
  // PB1新橋
  // ──────────────────────────────────────────
  console.log(`\n[PB1新橋] HTML取得開始 (${EXPORT_DAYS}日分)`);
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const shimCtx = await browser.newContext({ userAgent: UA, locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.9' } });
  const shimPage = await shimCtx.newPage();
  const availBase = `https://reserva.be/${SHIMBASHI_SLUG}/availability`;

  try {
    const firstStamp = today.replace(/-/g, '');
    await shimPage.goto(
      `${availBase}?bus_front_availability_date=${firstStamp}&bus_front_availability_time_from=6&bus_front_availability_time_to=23`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    try {
      await shimPage.waitForSelector('input[name="bus_front_availability_date"]', { timeout: 60000 });
      console.log('  カレンダー読み込み完了');
    } catch {
      console.warn('  [PB1新橋] カレンダー読み込み失敗（CF チャレンジ未解決）→ スキップ');
    }

    if (shimPage.url().includes('/login') || shimPage.url().includes('id-sso.reserva.be')) {
      console.warn('  [PB1新橋] ログインページへリダイレクト → スキップ');
    } else {
      const SHIM_COLS = 17, SHIM_START = 6;

      function processShimData(date: string, rowNames: string[], circleIndices: number[]) {
        for (const idx of circleIndices) {
          const row = Math.floor(idx / SHIM_COLS);
          const col = idx % SHIM_COLS;
          const hour = SHIM_START + col;
          const name = rowNames[row + 1] ?? '';
          if (!name.includes('レンタルコート')) continue;
          if (!isTargetHour(hour, date)) continue;
          const m = name.match(/（([^）]+)）/);
          const courtName = m ? m[1] : name.replace(/[【】]/g, '').trim();
          const key = `${date}|${hour}`;
          if (!shimbashiSlots[key]) shimbashiSlots[key] = [];
          if (!shimbashiSlots[key].includes(courtName)) shimbashiSlots[key].push(courtName);
        }
      }

      for (let i = 0; i < EXPORT_DAYS; i++) {
        const date = addDays(today, i);
        const stamp = date.replace(/-/g, '');
        const url = `${availBase}?bus_front_availability_date=${stamp}&bus_front_availability_time_from=6&bus_front_availability_time_to=23`;
        try {
          let html: string, rowNames: string[], circleIndices: number[];

          if (i === 0) {
            html = await shimPage.content();
            const dom = await shimPage.evaluate(() => {
              const ths = document.querySelectorAll('.availability-list__column-header thead tr th');
              const rowNames = Array.from(ths).map(th => (th as HTMLElement).textContent?.trim() ?? '');
              const cells = document.querySelectorAll('.availability-list__vacancy');
              const circleIndices: number[] = [];
              cells.forEach((cell, idx) => {
                if (cell.querySelector('a.availability-list__vacancy__data_link.circle')) circleIndices.push(idx);
              });
              return { rowNames, circleIndices };
            });
            rowNames = dom.rowNames;
            circleIndices = dom.circleIndices;
          } else {
            const fetched = await shimPage.evaluate(async (fetchUrl: string) => {
              const r = await fetch(fetchUrl, { method: 'GET', credentials: 'same-origin', headers: { 'Accept-Language': 'ja,en;q=0.9' } });
              const html = await r.text();
              const doc = new DOMParser().parseFromString(html, 'text/html');
              const ths = doc.querySelectorAll('.availability-list__column-header thead tr th');
              const rowNames = Array.from(ths).map(th => (th as HTMLElement).textContent?.trim() ?? '');
              const cells = doc.querySelectorAll('.availability-list__vacancy');
              const circleIndices: number[] = [];
              cells.forEach((cell, idx) => {
                if (cell.querySelector('a.availability-list__vacancy__data_link.circle')) circleIndices.push(idx);
              });
              return { html, rowNames, circleIndices };
            }, url);
            html = fetched.html;
            rowNames = fetched.rowNames;
            circleIndices = fetched.circleIndices;
          }

          if (!html.includes('bus_front_availability_date')) {
            console.warn(`  [${date}] カレンダーなし → スキップ`);
            continue;
          }
          files[`shimbashi_${stamp}.html`] = html;
          shimbashiDates.push(date);
          processShimData(date, rowNames, circleIndices);
          console.log(`  ${date} OK (${html.length}B, available:${circleIndices.length})`);
        } catch (e: any) {
          console.warn(`  [${date}] 取得失敗: ${e.message}`);
        }
      }
    }
  } finally {
    await shimPage.close();
    await shimCtx.close();
  }
  files['shimbashi_slots.json'] = makeSlotFile('PB1新橋', 'https://reserva.be/pboneginza', shimbashiSlots);
  console.log(`  shimbashi slots: ${Object.keys(shimbashiSlots).length}`);

  // ──────────────────────────────────────────
  // 東京タワー
  // ──────────────────────────────────────────
  console.log('\n[東京タワー] AjaxSearch JSON取得開始');
  const uniqueMonths = new Set<string>();
  for (let i = 0; i < EXPORT_DAYS; i++) uniqueMonths.add(addDays(today, i).slice(0, 7));

  const towerCtx = await browser.newContext({ userAgent: UA, locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.9' } });
  const towerPage = await towerCtx.newPage();
  try {
    await towerPage.goto(TOWER_BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await towerPage.waitForSelector('#reserve_bus_cd', { timeout: 20000 }); } catch {
      console.warn('  [東京タワー] ページ読み込み失敗 → スキップ');
    }

    if (towerPage.url().includes('/login') || towerPage.url().includes('id-sso.reserva.be')) {
      console.warn('  [東京タワー] ログインページへリダイレクト → スキップ');
    } else {
      for (const month of uniqueMonths) {
        const targetDate = month.replace('-', '/') + '/01';
        const stamp = month.replace('-', '');
        try {
          const calText: string = await towerPage.evaluate(async (td: string) => {
            const params = new URLSearchParams({
              cmd: 'get_new_institution', reserve_bus_cd: '341125', reserve_ist_no: '116556',
              target_date: td, mode: '', month_week: 'month',
              datetime_max_days: '1', select_timeorday: '1', price_type_no: '0',
            });
            const r = await fetch('/AjaxSearch', {
              method: 'POST',
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params.toString(),
            });
            return r.text();
          }, targetDate);

          if (!calText || calText.length < 10) { console.warn(`  [${month}] 空レスポンス → スキップ`); continue; }
          const parsed = JSON.parse(calText);
          files[`tower_${stamp}.json`] = calText;
          towerMonths.push(month);
          // Extract slots
          const monthSlots = extractTowerSlots(parsed.week_time_array ?? {}, today, 5);
          for (const [k, v] of Object.entries(monthSlots)) {
            if (!towerSlots[k]) towerSlots[k] = v;
            else for (const c of v) if (!towerSlots[k].includes(c)) towerSlots[k].push(c);
          }
          console.log(`  ${month} OK (${calText.length}B)`);
        } catch (e: any) {
          console.warn(`  [${month}] 取得失敗: ${e.message}`);
        }
      }
    }
  } finally {
    await towerPage.close();
    await towerCtx.close();
  }
  files['tower_slots.json'] = makeSlotFile('東京タワー', 'https://reserva.be/tokyotowerpickleball', towerSlots);
  console.log(`  tower slots: ${Object.keys(towerSlots).length}`);

  // ──────────────────────────────────────────
  // PBT (labola.jp) — rate-limited
  // ──────────────────────────────────────────
  console.log(`\n[PBT] HTML取得開始 (${LABOLA_DAYS}日分)`);
  const LABOLA_SHOP = '3473';
  const LABOLA_TAB = encodeURIComponent('ピックルボールコート');

  for (let i = 0; i < LABOLA_DAYS; i++) {
    const date = addDays(today, i);
    const [y, mo, d] = date.split('-');
    const url = `https://yoyaku.labola.jp/r/shop/${LABOLA_SHOP}/calendar/${y}/${Number(mo)}/${Number(d)}/?tab_name=${LABOLA_TAB}`;
    const stamp = date.replace(/-/g, '');

    if (i > 0 && i % 3 === 0) await new Promise(r => setTimeout(r, 120000));
    else if (i > 0) await new Promise(r => setTimeout(r, 2000));

    let succeeded = false;
    for (let attempt = 0; attempt < 2 && !succeeded; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 10000));
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9', 'Accept': 'text/html', 'Referer': `https://yoyaku.labola.jp/r/shop/${LABOLA_SHOP}/` },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) { console.warn(`  [${date}] HTTP ${res.status} (attempt ${attempt + 1})`); continue; }
        const html = await res.text();
        if (!html.includes(`/shop/${LABOLA_SHOP}/`)) { console.warn(`  [${date}] カレンダー確認できず (attempt ${attempt + 1})`); continue; }
        files[`labola_${stamp}.html`] = html;
        labolaDates.push(date);
        console.log(`  ${date} OK (${html.length}B)`);
        succeeded = true;
      } catch (e: any) {
        console.warn(`  [${date}] 取得失敗 (attempt ${attempt + 1}): ${e.message}`);
      }
    }
    if (!succeeded) console.warn(`  [${date}] スキップ`);
  }

  // ──────────────────────────────────────────
  // Sansan池袋
  // ──────────────────────────────────────────
  console.log('\n[Sansan池袋] API取得開始');
  try {
    const slots = await fetchSansanSlots(today, 4);
    files['sansan_slots.json'] = makeSlotFile('Sansan池袋', 'https://reserve.sansan-pickleball.com', slots);
    console.log(`  sansan slots: ${Object.keys(slots).length}`);
  } catch (e: any) { console.warn(`  [Sansan] エラー: ${e.message}`); }

  // ──────────────────────────────────────────
  // andpickle
  // ──────────────────────────────────────────
  console.log('\n[andpickle] API取得開始');
  try {
    const slots = await fetchAndPickleSlots(today);
    files['andpickle_slots.json'] = makeSlotFile('andpickle', 'https://reserve.andpickle.jp/reserve', slots);
    console.log(`  andpickle slots: ${Object.keys(slots).length}`);
  } catch (e: any) { console.warn(`  [andpickle] エラー: ${e.message}`); }

  // ──────────────────────────────────────────
  // pickle9
  // ──────────────────────────────────────────
  console.log('\n[pickle9] API取得開始');
  try {
    const slots = await fetchPickle9Slots(today);
    files['pickle9_slots.json'] = makeSlotFile('pickle9', 'https://loun9ine.hacomono.jp/reserve/schedule/22/62', slots);
    console.log(`  pickle9 slots: ${Object.keys(slots).length}`);
  } catch (e: any) { console.warn(`  [pickle9] エラー: ${e.message}`); }

  // ──────────────────────────────────────────
  // PB1豊洲
  // ──────────────────────────────────────────
  console.log('\n[PB1豊洲] Playwright取得開始');
  try {
    const slots = await fetchToyosuSlots(browser, today, 4);
    files['toyosu_slots.json'] = makeSlotFile('PB1豊洲', 'https://rsv.pickle-one.com/pb1-toyosu/reservations/new/slots', slots);
    console.log(`  toyosu slots: ${Object.keys(slots).length}`);
  } catch (e: any) { console.warn(`  [PB1豊洲] エラー: ${e.message}`); }

  // ──────────────────────────────────────────
  // パシフィック
  // ──────────────────────────────────────────
  console.log('\n[パシフィック] Playwright取得開始');
  try {
    const slots = await fetchPacificSlots(browser, today, 3);
    files['pacific_slots.json'] = makeSlotFile('パシフィックピックルクラブ', 'https://pacificpickleclub.resv.jp/reserve/calendar.php', slots);
    console.log(`  pacific slots: ${Object.keys(slots).length}`);
  } catch (e: any) { console.warn(`  [パシフィック] エラー: ${e.message}`); }

  // ──────────────────────────────────────────
  // metadata
  // ──────────────────────────────────────────
  files['metadata.json'] = JSON.stringify({
    updatedAt: now,
    shimbashiDates,
    towerMonths,
    labolaDates,
    slotFiles: [
      'shimbashi_slots.json',
      'tower_slots.json',
      'sansan_slots.json',
      'toyosu_slots.json',
      'pacific_slots.json',
      'andpickle_slots.json',
      'pickle9_slots.json',
    ],
  });

  console.log(`\n取得結果: 新橋 ${shimbashiDates.length}日 / タワー ${towerMonths.length}ヶ月 / PBT ${labolaDates.length}/${LABOLA_DAYS}日`);
  await updateGist(files);
  await browser.close();
  console.log('完了');
})().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
