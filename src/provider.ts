import type { VaultProvider, ProviderContext, DownloadFile, AddTaskParams, AddTaskResponse, ProviderResult, TaskResult } from '@vault-flow/provider-api';
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

  private async launchBrowser(ctx: ProviderContext): Promise<{ browser: Browser; page: Page }> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }) as Browser;
    const cookies = ctx.storage.get<string>(STORAGE_KEY_COOKIES) || '';
    const page = await browser.newPage();
    if (cookies) {
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
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

  async addTask(ctx: ProviderContext, params: AddTaskParams): Promise<AddTaskResponse> {
    const cookies = params.cookies as string || ctx.storage.get<string>(STORAGE_KEY_COOKIES) || '';
    if (!cookies) {
      return { success: false, message: 'Cookies are required' };
    }
    ctx.storage.set(STORAGE_KEY_COOKIES, cookies);

    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      }) as Browser;
      page = await browser!.newPage();
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieObjects = cookiePairs.map(pair => {
        const [name, ...valueParts] = pair.split('=');
        return { name: name.trim(), value: valueParts.join('='), domain: '.instagram.com', path: '/' };
      }).filter(c => c.name);
      if (cookieObjects.length > 0) {
        await page.setCookie(...cookieObjects);
      }

      const result = await this.checkLogin(page);
      if (!result.username) {
        return { success: false, message: 'Invalid cookies or login failed' };
      }

      return {
        success: true,
        name: result.username,
        userId: result.userId,
        interval: (params.interval as number) || 1800,
      };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  async deleteTask(ctx: ProviderContext, taskId: string): Promise<ProviderResult> {
    const hasDownloads = ctx.hasPostDownloadRecord(taskId);
    if (hasDownloads) {
      return { success: false, message: 'Task has associated downloads' };
    }
    ctx.storage.clear();
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

  private async fetchItems(page: Page, username: string, skipIds?: string[], endCursor?: string | null): Promise<{ items: InstagramItem[]; endCursor: string | null; hasNextPage: boolean }> {
    let allItems: InstagramItem[] = [];
    let nextCursor: string | null = null;
    let hasNext = false;

    const savedUrl = `https://www.instagram.com/${username}/saved/all-posts/`;
    const handler = async (res: HTTPResponse) => {
      const url = res.url();
      try {
        if (url.includes('/api/v1/feed/saved/posts/')) {
          const text = await res.text();
          const parsed = JSON.parse(text) as SavedPostsApiResponse;
          if (parsed?.items?.length) {
            const { items, hasMore } = parseSavedPostsResponse(parsed, username);
            for (const item of items) {
              if (!allItems.find(x => x.id === item.id)) allItems.push(item);
            }
            hasNext = hasMore;
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

        const { items, endCursor: ec, hasNextPage: hp } = parseApiResponse(parsed, username);
        if (items.length > 0) {
          for (const item of items) {
            if (!allItems.find(x => x.id === item.id)) allItems.push(item);
          }
          if (ec) nextCursor = ec;
          if (hp) hasNext = hp;
        }
      } catch (_e) { /* */ }
    };

    page.on('response', handler);
    try {
      const navigateUrl = endCursor ? `${savedUrl}?max_id=${endCursor}` : savedUrl;
      try {
        await page.goto(navigateUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (_navErr) {
        console.log('[instagram] fetchItems: navigation ended (possibly no more pages)');
      }
      for (let i = 0; i < 30 && allItems.length === 0; i++) {
        await new Promise<void>(r => setTimeout(r, 1000));
      }
    } finally {
      page.off('response', handler);
    }

    const filtered = allItems.filter(item => !skipIds || skipIds.indexOf(item.id) < 0);
    console.log(`[instagram] fetchItems: ${allItems.length} total, ${filtered.length} after filter`);
    return { items: filtered, endCursor: nextCursor, hasNextPage: hasNext };
  }

  async executeTask(ctx: ProviderContext): Promise<TaskResult> {
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
        return { state: TaskState.LoginExpired, message: 'status.login_expired', downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
      }
      ctx.addLog('info', `Instagram login OK: ${username} (${userId})`);

      const handle = userId;

      let downloaded = 0, failed = 0;
      const skipIds: string[] = [];

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

      const processItem = async (item: InstagramItem): Promise<void> => {
        skipIds.push(item.id);
        if (ctx.hasSuccessfulDownloadRecord(item.id)) {
          if (item.bookmarked) await handleUnsave(item);
          return;
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
          return;
        }
        try {
          const files: DownloadFile[] = [];
          const userDir = ctx.path.join(ctx.configDir, 'downloads', handle, item.authorId || 'unknown');
          if (!ctx.fs.existsSync(userDir)) ctx.fs.mkdirSync(userDir, { recursive: true });
          for (const dl of mediaUrls) {
            files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Downloading });
          }
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Downloading, stateMessage: '',
            files, dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });

          const cookies = ctx.storage.get<string>(STORAGE_KEY_COOKIES) || '';
          for (const dl of mediaUrls) {
            for (const url of dl.urls) {
              try {
                const response = await fetch(url, {
                  headers: { 'Cookie': cookies, 'Referer': 'https://www.instagram.com/' },
                });
                if (response.ok) {
                  const buffer = await response.arrayBuffer();
                  const dest = ctx.path.join(userDir, dl.filename);
                  const nodeFs = require('fs');
                  nodeFs.writeFileSync(dest, Buffer.from(buffer));
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
              } catch (_e) { /* retry next url */ }
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
          console.error('[instagram] download error:', (err as Error).message);
          ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50),
            files: [], dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });
          failed++;
        }
      };

      try {
        let endCursor: string | null = null;
        let maxRequestCount = 20;
        let processedCount = 0;

        do {
          const fetched = await this.fetchItems(page, handle, skipIds, endCursor);
          maxRequestCount--;
          endCursor = fetched.endCursor;
          for (const item of fetched.items) {
            await processItem(item);
          }
          processedCount += fetched.items.length;
          ctx.emitTaskProgress(processedCount, processedCount);
          if (fetched.items.length > 0) {
            await new Promise<void>(r => setTimeout(r, 3000));
          }
        } while (endCursor && maxRequestCount > 0);
      } catch (err) {
        ctx.addLog('error', `Instagram task error: ${(err as Error).message}`);
        return { state: TaskState.Error, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
      } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
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
      if (browser) await browser.close().catch(() => {});
    }
  }
}
