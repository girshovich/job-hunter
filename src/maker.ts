/**
 * The person behind the app, in one place. Read by the layout (profile menus, Donate panel),
 * the job-detail partial (end-of-page credit, Offer ask) and the digest email footer.
 * See donations.md.
 */
export const MAKER = {
  name: 'Mikhail Girshovich',
  shortName: 'Misha',
  email: 'mikhail@girshovich.me',
  linkedin: 'https://www.linkedin.com/in/girshovich/',
  photo: '/misha.webp',
  tributeTelegram: 'https://t.me/tribute/app?startapp=dQCn',
  // Tribute in the browser, email verification — the "Not on Telegram?" route.
  tributeWeb: 'https://web.tribute.tg/d/QCn',
  hipolink: 'https://hipolink.net/girshovich/tips',
} as const;
