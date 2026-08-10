import type { VaultProvider, ProviderContext, DownloadFile, AddTaskResult, DeleteTaskResult, ExecuteTaskResult, TaskErrorResult } from '@vault-flow/provider-api';
import { MediaType, FileStatus, DownloadStatus, TaskState } from '@vault-flow/provider-api';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, HTTPResponse } from 'puppeteer-core';
import { InstagramItem, NewApiResponse, SavedPostsApiResponse, parseApiResponse, parseSavedPostsResponse, getMediaUrls } from './api';
import { unsavePage } from './actions';

puppeteer.use(StealthPlugin());

const STORAGE_KEY_COOKIES = 'cookies';

export class InstagramSavedProvider implements VaultProvider {
  constructor() {}

  private async launchBrowser(ctx: ProviderContext, cookies?: string): Promise<{ browser: Browser; page: Page }> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }) as Browser;
    const cookieStr = cookies || (ctx.config.cookies as string) || '';
    const page = await browser.newPage();
    if (cookieStr) {
      const cookiePairs = cookieStr.split(';').map(c => c.trim()).filter(Boolean);
      const cookieObjects = cookiePairs.map(pair => {
        const [name, ...valueParts] = pair.split('=');
        return { name: name.trim(), value: valueParts.join('='), domain: '.instagram.com', path: '/' };
      }).filter(c => c.name);
      if (cookieObjects.length > 0) {
        await page.setCookie(...cookieObjects);
      }
    }
    return { browser, page };
  }

  private msg(locale: string, key: string, fallback: string): string {
    const messages: Record<string, Record<string, string>> = {
      'cookie_required': { 'zh-CN': '请填写 Cookie', 'zh-TW': '請填寫 Cookie', 'en-US': 'Cookies are required' },
      'login_failed': { 'zh-CN': 'Instagram 登录失败，请检查 Cookie', 'zh-TW': 'Instagram 登入失敗，請檢查 Cookie', 'en-US': 'Invalid cookies or login failed' },
      'login_expired': { 'zh-CN': 'Instagram 登录已过期', 'zh-TW': 'Instagram 登入已過期', 'en-US': 'Instagram login expired' },
    };
    const m = messages[key];
    return m ? (m[locale] || m['en-US'] || fallback) : fallback;
  }

  async addTask(ctx: ProviderContext): Promise<AddTaskResult | TaskErrorResult> {
    const cookies = (ctx.config.cookies as string) || '';
    if (!cookies) {
      return { success: false, message: this.msg(ctx.locale, 'cookie_required', 'Cookies are required') };
    }

    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      const launched = await this.launchBrowser(ctx, cookies);
      browser = launched.browser;
      page = launched.page;

      const result = await this.checkLogin(page);
      if (!result.username) {
        return { success: false, message: this.msg(ctx.locale, 'login_failed', 'Invalid cookies or login failed') };
      }

      return {
        success: true,
        name: result.username,
      };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) {
        await Promise.race([
          browser.close(),
          new Promise<void>(r => setTimeout(() => { try { (browser as any).process()?.kill(); } catch {} r(); }, 10000)),
        ]).catch(() => {});
      }
    }
  }

  async deleteTask(ctx: ProviderContext, taskId: string): Promise<DeleteTaskResult | TaskErrorResult> {
    return { success: true };
  }

  async onTaskConfigUpdate(_ctx: ProviderContext, _taskId: string): Promise<DeleteTaskResult> {
    return { success: true };
  }

  private async checkLogin(page: Page, timeout = 60000): Promise<{ username: string; userId: string }> {
    let username = '', userId = '';
    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout });
      await new Promise<void>(r => setTimeout(r, 3000));

      const result = await page.evaluate(() => {
        if (window.location.href.includes('login')) return { displayName: '', handle: '' };

        let handle = '';
        const links = document.querySelectorAll('a');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
          if (match && ['login', 'explore', 'accounts', 'reels', 'saved', 'popular', 'direct'].indexOf(match[1]) === -1) {
            handle = match[1];
            break;
          }
        }

        return { handle };
      });

      if (result.handle) {
        userId = result.handle;

        await page.goto(`https://www.instagram.com/${result.handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise<void>(r => setTimeout(r, 2000));

        const displayName = await page.evaluate(() => {
          const meta = document.querySelector('meta[property="og:description"]');
          const content = meta?.getAttribute('content') || '';
          const match = content.match(/from\s+(.+?)\s*\(@/);
          return match ? match[1] : '';
        });

        username = displayName || userId;
      }
    } catch (err) {
      console.error('[instagram] checkLogin error:', (err as Error).message);
    }
    return { username, userId };
  }

  private async collectItems(page: Page, username: string, maxItems = 100): Promise<InstagramItem[]> {
    const allItems: InstagramItem[] = [];
    const seenIds = new Set<string>();
    const savedUrl = `https://www.instagram.com/${username}/saved/all-posts/`;

    const handler = async (res: HTTPResponse) => {
      const url = res.url();
      try {
        if (url.includes('/api/v1/feed/saved/posts/')) {
          const text = await res.text();
          const parsed = JSON.parse(text) as SavedPostsApiResponse;
          if (parsed?.items?.length) {
            const { items } = parseSavedPostsResponse(parsed, username);
            for (const item of items) {
              if (!seenIds.has(item.id)) { seenIds.add(item.id); allItems.push(item); }
            }
          }
          return;
        }
        if (!url.includes('graphql') && !url.includes('api/graphql')) return;
        const text = await res.text();
        let parsed: NewApiResponse | null = null;
        try { parsed = JSON.parse(text); } catch (_e) {
          const match = text.match(/=\s*({.+})\s*;?\s*$/s);
          if (match) { try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ } }
        }
        if (!parsed) return;
        const { items } = parseApiResponse(parsed, username);
        for (const item of items) {
          if (!seenIds.has(item.id)) { seenIds.add(item.id); allItems.push(item); }
        }
      } catch (_e) { /* */ }
    };

    page.on('response', handler);
    try {
      try {
        await page.goto(savedUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (_navErr) { /* */ }
      for (let i = 0; i < 15 && allItems.length === 0; i++) {
        await new Promise<void>(r => setTimeout(r, 1000));
      }
      while (allItems.length < maxItems) {
        const prevCount = allItems.length;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
        await new Promise<void>(r => setTimeout(r, 3000));
        for (let i = 0; i < 5 && allItems.length === prevCount; i++) {
          await new Promise<void>(r => setTimeout(r, 1000));
        }
        if (allItems.length === prevCount) break;
      }
      console.log(`[instagram] collectItems: ${allItems.length} items collected`);
      return allItems.slice(0, maxItems);
    } finally {
      page.off('response', handler);
    }
  }

  async executeTask(ctx: ProviderContext): Promise<ExecuteTaskResult> {
    const startTime = Date.now();
    console.log(`[instagram] executeTask: ${ctx.taskId}`);

    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      const launched = await this.launchBrowser(ctx);
      browser = launched.browser;
      page = launched.page;

      const { username, userId } = await this.checkLogin(page);

      if (!userId) {
        ctx.addLog('warn', 'Instagram login expired');
        return { state: TaskState.LoginExpired, message: this.msg(ctx.locale, 'login_expired', 'Instagram login expired'), downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
      }
      ctx.addLog('info', `Instagram login OK: ${username} (${userId})`);

      const handle = userId;

      const handleUnsave = async (item: InstagramItem) => {
        const actionPage = await browser!.newPage();
        let ok = false;
        try {
          ok = await unsavePage(actionPage, item.detailUrl);
        } catch (err) {
          ctx.addLog('error', `Unsave exception: ${item.id} - ${(err as Error).message}`);
        } finally {
          await actionPage.close().catch(() => {});
        }
        if (!ok) {
          ctx.addLog('warn', `Unsave failed: ${item.id} (${item.authorId})`);
        }
      };

      // Phase 1: Collect items
      const items = await this.collectItems(page, handle);
      await page.close().catch(() => {});
      page = null;
      ctx.addLog('info', `Collected ${items.length} items`);

      // Phase 2: Download all items
      ctx.emitTaskProgress(0, items.length);
      let downloaded = 0, failed = 0;
      for (let i = 0; i < items.length; i++) {
        ctx.emitTaskProgress(i, items.length);
        const item = items[i];
        if (ctx.hasSuccessfulDownloadRecord(item.id)) {
          if (item.bookmarked) await handleUnsave(item);
          continue;
        }
        const mediaUrls = getMediaUrls(item);
        if (mediaUrls.length === 0) {
          ctx.addLog('info', `No media: ${item.id} (${item.authorId})`);
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Success, stateMessage: 'status.no_media',
            files: [{ type: MediaType.Text, filename: 'status.no_media', url: '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Success }],
            dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });
          if (item.bookmarked) await handleUnsave(item);
          continue;
        }
        try {
          const files: DownloadFile[] = [];
          const downloadPathTemplate = (ctx.config.downloadPath as string) || '{type}/{user}/{author_id}_{author}';
          const vars: Record<string, string> = {
            type: 'instagram', user: handle,
            author: item.author || 'unknown', author_id: item.authorId || 'unknown'
          };
          const userDir = ctx.path.join(ctx.downloadDir, downloadPathTemplate.replace(/\{(\w+)\}/g, (_, k) => vars[k] || k));
          if (!ctx.fs.existsSync(userDir)) ctx.fs.mkdirSync(userDir, { recursive: true });
          for (const dl of mediaUrls) {
            files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Downloading });
          }
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Downloading, stateMessage: '',
            files, dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });

          const cookies = (ctx.config.cookies as string) || '';
          for (const dl of mediaUrls) {
            for (const url of dl.urls) {
              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                const response = await fetch(url, {
                  headers: { 'Cookie': cookies, 'Referer': 'https://www.instagram.com/' },
                  signal: controller.signal,
                });
                clearTimeout(timeout);
                if (response.ok) {
                  const buffer = await response.arrayBuffer();
                  const dest = ctx.path.join(userDir, dl.filename);
                  ctx.fs.writeFileSync(dest, Buffer.from(buffer) as unknown as string);
                  const fi = files.findIndex(f => f.filename === dl.filename);
                  if (fi >= 0) {
                    files[fi].fileSize = buffer.byteLength;
                    files[fi].fileExpectedSize = buffer.byteLength;
                    files[fi].url = url;
                    files[fi].fileStatus = FileStatus.Success;
                    ctx.updateDownloadRecord(item.id, { files });
                  }
                  break;
                }
              } catch (e) {
                ctx.addLog('warn', `Download error for ${dl.filename}: ${(e as Error).message?.slice(0, 80)}`);
              }
            }
          }

          const allSuccess = files.length > 0 && files.every(f => f.fileStatus === FileStatus.Success);
          if (allSuccess) {
            ctx.updateDownloadRecord(item.id, { state: DownloadStatus.Success, stateMessage: '', files });
            ctx.addLog('info', `Downloaded: ${item.author} (${item.authorId})/${item.id} | ${files.length} files`);
            downloaded++;
            if (item.bookmarked) await handleUnsave(item);
          } else {
            const failedFiles = files.filter(f => f.fileStatus !== FileStatus.Success).map(f => `${f.filename}(${f.fileStatus})`).join(', ');
            ctx.updateDownloadRecord(item.id, { state: DownloadStatus.Failed, stateMessage: `partial: ${failedFiles}`, files });
            ctx.addLog('warn', `Partial download failed: ${item.id} (${item.authorId}) | failed files: ${failedFiles}`);
            failed++;
          }
        } catch (err) {
          ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50),
            files: [], dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });
          failed++;
        }
        ctx.emitTaskProgress(i + 1, items.length);
      }

      return {
        state: TaskState.Success,
        message: 'ok',
        downloaded, failed,
        total: downloaded + failed,
        duration: Date.now() - startTime
      };
    } catch (err) {
      ctx.addLog('error', `Instagram task error: ${(err as Error).message}`);
      return { state: TaskState.Error, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) {
        await Promise.race([
          browser.close(),
          new Promise<void>(r => setTimeout(() => { try { (browser as any).process()?.kill(); } catch {} r(); }, 10000)),
        ]).catch(() => {});
      }
    }
  }
}
