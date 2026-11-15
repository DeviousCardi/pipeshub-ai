import type { Request } from 'express';
import { requestLocale } from '../domain/output-locale';

/** G-52: the person's locale as a request names it (`Accept-Language`), for admission; none when it names none. */
export function localeOf(req: Pick<Request, 'headers'>): { locale?: string } {
  const locale = requestLocale(req.headers?.['accept-language']);
  return locale === undefined ? {} : { locale };
}
