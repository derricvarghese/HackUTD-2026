import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true } as const;
const wrap = (children: ReactNode, p: P, vb = '0 0 24 24') => (
  <svg viewBox={vb} {...base} {...p}>
    {children}
  </svg>
);

export const LogoMark = (p: P) => (
  <svg width="46" height="34" viewBox="0 0 46 34" aria-hidden="true" {...p}>
    <path d="M2 18h9l4-10 6 20 6-16 4 6h13" fill="none" stroke="#F26B1D" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const IcHome = (p: P) => wrap(<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z" />, p);
export const IcPin = (p: P) =>
  wrap(
    <>
      <path d="M12 22s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z" />
      <circle cx="12" cy="10" r="2.5" />
    </>,
    p,
  );
export const IcList = (p: P) => wrap(<path d="M4 6h16M4 12h10M4 18h6" />, p);
export const IcCheck = (p: P) =>
  wrap(
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 12l3 3 5-6" />
    </>,
    p,
  );
export const IcMesh = (p: P) =>
  wrap(
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2" />
    </>,
    p,
  );
export const IcPeople = (p: P) =>
  wrap(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6" />
    </>,
    p,
  );
export const IcHeart = (p: P) => wrap(<path d="M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z" />, p);
export const IcCog = (p: P) =>
  wrap(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>,
    p,
  );
export const IcSearch = (p: P) =>
  wrap(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>,
    p,
  );
export const IcWaves = (p: P) => (
  <svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="#2563EB" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...p}>
    <path d="M1 6c2.5-2.5 5-2.5 7.3 0s4.9 2.5 7.3 0 5-2.5 7.4 0M1 13c2.5-2.5 5-2.5 7.3 0s4.9 2.5 7.3 0 5-2.5 7.4 0" />
  </svg>
);
export const IcOpenSos = (p: P) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="#2563EB" aria-hidden="true" {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 4a8 8 0 018 8h-2a6 6 0 00-6-6zM12 20a8 8 0 01-8-8h2a6 6 0 006 6z" />
    <path d="M12 1a11 11 0 0111 11h-2A9 9 0 0012 3zM12 23A11 11 0 011 12h2a9 9 0 009 9z" opacity=".5" />
  </svg>
);
export const IcWarn = (p: P) => (
  <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true" {...p}>
    <path d="M12 2L1 21h22z" fill="#E0393E" />
    <path d="M12 9v5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="12" cy="17.3" r="1.3" fill="#fff" />
  </svg>
);
export const IcSilent = (p: P) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...p}>
    <path d="M2 12h3M19 12h3" />
    <path d="M7 8.5a5 5 0 000 7M17 8.5a5 5 0 010 7" />
    <path d="M4 4l16 16" />
  </svg>
);
export const IcHelmet = (p: P) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="#16A34A" aria-hidden="true" {...p}>
    <path d="M4 16a8 8 0 0116 0v1H4z" />
    <rect x="2.5" y="17" width="19" height="3" rx="1.5" />
    <path d="M11 5h2v6h-2z" fill="#fff" opacity=".8" />
  </svg>
);
export const IcLayers = (p: P) => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" {...p}>
    <path d="M3 7l9-4 9 4-9 4z" fill="#E0393E" />
    <path d="M3 12l9 4 9-4M3 17l9 4 9-4" stroke="#E0393E" strokeWidth="2" fill="none" />
  </svg>
);
export const IcFeed = (p: P) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F26B1D" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...p}>
    <circle cx="12" cy="12" r="2" fill="#F26B1D" />
    <path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2" />
  </svg>
);
export const IcNodes = (p: P) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.2" aria-hidden="true" {...p}>
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="6" r="2.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M7 16l3-2.5M14 10.5L17 8" />
  </svg>
);
export const IcHeartFill = (p: P) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="#16A34A" aria-hidden="true" {...p}>
    <path d="M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z" />
  </svg>
);
export const IcBoat = (p: P) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...p}>
    <path d="M3 15h18l-3 5H6zM12 4v11M12 4l6 8h-6" />
  </svg>
);
export const IcDrop = (p: P) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...p}>
    <path d="M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z" />
  </svg>
);
export const IcPlus = (p: P) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E0393E" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IcMenu = (p: P) => wrap(<path d="M4 6h16M4 12h16M4 18h16" />, p);
export const IcLock = (p: P) =>
  wrap(
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>,
    p,
  );
