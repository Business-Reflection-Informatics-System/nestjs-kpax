import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpService } from '@nestjs/axios';

export interface Seen {
  method: string;
  url: URL;
  auth?: string;
  body: string;
}

export interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export const json = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): MockReply => ({ status, body, headers });

/** A fake KPAX (any host) behind a real axios instance. */
export class MockKpax {
  calls: Seen[] = [];
  tokenRequests: { host: string; form: URLSearchParams }[] = [];
  handler: (req: Seen) => MockReply = () => json({ status: 'ok' });
  tokenHandler: ((host: string, form: URLSearchParams) => MockReply) | null =
    null;
  private seq = 0;

  readonly axios = axios.create({
    adapter: async (config: AxiosRequestConfig): Promise<AxiosResponse> => {
      const url = new URL(axios.getUri(config));
      const method = (config.method ?? 'get').toUpperCase();
      const body = typeof config.data === 'string' ? config.data : '';
      const headers = config.headers as any;
      const auth = headers?.get?.('Authorization') ?? headers?.Authorization;

      let out: MockReply;
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(body);
        this.tokenRequests.push({ host: url.origin, form });
        out = this.tokenHandler?.(url.origin, form) ?? {
          status: 200,
          body: {
            token_type: 'Bearer',
            expires_in: 3600,
            access_token: `tok-${++this.seq}`,
          },
        };
      } else {
        const seen = { method, url, auth, body };
        this.calls.push(seen);
        out = this.handler(seen);
      }
      return {
        status: out.status,
        statusText: String(out.status),
        headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
        data: out.body === undefined ? '' : JSON.stringify(out.body),
        config: config as any,
        request: {},
      };
    },
  });

  httpService(): HttpService {
    return new HttpService(this.axios);
  }
}
