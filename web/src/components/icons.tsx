import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

const base = { fill: 'currentColor', 'aria-hidden': true } as const;

const wrap = (d: string, p: IconProps, vb = '0 0 24 24') => (
  <svg viewBox={vb} width="24" height="24" {...base} {...p}>
    <path d={d} />
  </svg>
);

/** Custom pulse logo mark for Beacon */
export const LogoMark = (p: IconProps) => (
  <svg width="46" height="34" viewBox="0 0 46 34" aria-hidden="true" {...p}>
    <path d="M2 18h9l4-10 6 20 6-16 4 6h13" fill="none" stroke="#F26B1D" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Google Material Symbol: home */
export const IcHome = (p: IconProps) => wrap('M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z', p);

/** Google Material Symbol: location_on */
export const IcPin = (p: IconProps) => wrap('M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z', p);

/** Google Material Symbol: format_list_bulleted */
export const IcList = (p: IconProps) => wrap('M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z', p);

/** Google Material Symbol: check_circle */
export const IcCheck = (p: IconProps) => wrap('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z', p);

/** Google Material Symbol: hub */
export const IcMesh = (p: IconProps) => wrap('M12 2a3 3 0 0 0-3 3c0 .34.06.66.17.96L6.5 8.63A2.99 2.99 0 0 0 5 8a3 3 0 1 0 2.83 4h8.34A2.99 2.99 0 0 0 19 11a3 3 0 1 0-3-3c0 .34.06.66.17.96L13.5 11.63A2.99 2.99 0 0 0 12 11a3 3 0 0 0-2.83 2H5.17A2.99 2.99 0 0 0 5 14a3 3 0 1 0 3-3c0-.34-.06-.66-.17-.96L10.5 7.37A2.99 2.99 0 0 0 12 8a3 3 0 1 0 0-6z', p);

/** Google Material Symbol: group */
export const IcPeople = (p: IconProps) => wrap('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z', p);

/** Google Material Symbol: favorite_border */
export const IcHeart = (p: IconProps) => wrap('M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z', p);

/** Google Material Symbol: favorite */
export const IcHeartFill = (p: IconProps) => wrap('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z', p);

/** Google Material Symbol: settings */
export const IcCog = (p: IconProps) => wrap('M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.484.484 0 0 0 13.9 3h-3.8c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.8c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z', p);

/** Google Material Symbol: search */
export const IcSearch = (p: IconProps) => wrap('M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z', p);

/** Google Material Symbol: waves */
export const IcWaves = (p: IconProps) => wrap('M12 6c-2.67 0-4.33 1.33-5 4 1-.67 2.17-.83 3.5-.5.76.19 1.31.74 1.91 1.35.98 1 2.09 2.15 4.59 2.15 2.67 0 4.33-1.33 5-4-1 .67-2.17.83-3.5.5-.76-.19-1.3-.74-1.91-1.35C15.61 7.15 14.5 6 12 6zm-7 7c-2.67 0-4.33 1.33-5 4 1-.67 2.17-.83 3.5-.5.76.19 1.3.74 1.91 1.35.98 1 2.09 2.15 4.59 2.15 2.67 0 4.33-1.33 5-4-1 .67-2.17.83-3.5.5-.76-.19-1.3-.74-1.91-1.35C10.61 14.15 9.5 13 7 13z', p);

/** Google Material Symbol: emergency */
export const IcOpenSos = (p: IconProps) => wrap('M10.5 21v-5.25L6.75 18 5 15l4.5-2.6L5 9.8 6.75 6.8l3.75 2.25V3.8h3.5v5.25L17.75 6.8 19.5 9.8 15 12.4l4.5 2.6-1.75 3-3.75-2.25V21h-3.5z', p);

/** Google Material Symbol: warning */
export const IcWarn = (p: IconProps) => wrap('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z', p);

/** Google Material Symbol: notifications_off */
export const IcSilent = (p: IconProps) => wrap('M20 18.69L7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.43v5l-2 2v1h15.73l2.51 2.51 1.27-1.27-3.51-3.55zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.77.19-1.47.51-2.09.94L18 14.68z', p);

/** Google Material Symbol: health_and_safety */
export const IcHelmet = (p: IconProps) => wrap('M10.5 13H8v-3h2.5V7.5h3V10H16v3h-2.5v2.5h-3V13zM12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z', p);

/** Google Material Symbol: layers */
export const IcLayers = (p: IconProps) => wrap('M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9.07l-9-7-9 7 1.63 1.27L12 16z', p);

/** Google Material Symbol: rss_feed */
export const IcFeed = (p: IconProps) => wrap('M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9zM6.18 15.64A2.18 2.18 0 1 0 8.36 17.82c0-1.2-.98-2.18-2.18-2.18z', p);

/** Google Material Symbol: share / polyline */
export const IcNodes = (p: IconProps) => wrap('M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z', p);

/** Google Material Symbol: sailing */
export const IcBoat = (p: IconProps) => wrap('M20 21c-1.39 0-2.78-.47-4-1.32-2.44 1.71-5.56 1.71-8 0C6.78 20.53 5.39 21 4 21H2v2h2c1.38 0 2.74-.35 4-.99 2.52 1.29 5.48 1.29 8 0 1.26.65 2.62.99 4 .99h2v-2h-2zM4 17h16c.55 0 1-.45 1-1 0-.09-.01-.18-.04-.27l-2.46-7.38H15v6h-2V2l-9.39 12.52A1 1 0 0 0 4 15.6c.03.77.58 1.4 1.34 1.4z', p);

/** Google Material Symbol: water_drop */
export const IcDrop = (p: IconProps) => wrap('M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8zm0 18c-3.35 0-6-2.57-6-6.2 0-2.34 1.95-5.44 6-9.14 4.05 3.7 6 6.79 6 9.14 0 3.63-2.65 6.2-6 6.2z', p);

/** Google Material Symbol: add */
export const IcPlus = (p: IconProps) => wrap('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z', p);

/** Google Material Symbol: menu */
export const IcMenu = (p: IconProps) => wrap('M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z', p);

/** Google Material Symbol: lock */
export const IcLock = (p: IconProps) => wrap('M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z', p);

/** Google Material Symbol: photo_camera */
export const IcCamera = (p: IconProps) => wrap('M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z', p);
