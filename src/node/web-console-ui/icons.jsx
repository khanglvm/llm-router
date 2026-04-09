export function DragGripIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="5" cy="4" r="1.25" fill="currentColor" />
      <circle cx="11" cy="4" r="1.25" fill="currentColor" />
      <circle cx="5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="11" cy="8" r="1.25" fill="currentColor" />
      <circle cx="5" cy="12" r="1.25" fill="currentColor" />
      <circle cx="11" cy="12" r="1.25" fill="currentColor" />
    </svg>
  );
}

export function ArrowUpIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 12V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 7.25 8 4l3.25 3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowDownIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 8.75 8 12l3.25-3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GitHubIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.2-.02-2.18-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.72-1.54-2.56-.29-5.25-1.28-5.25-5.71 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a10.9 10.9 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.44-2.69 5.41-5.26 5.69.41.35.78 1.05.78 2.11 0 1.52-.01 2.75-.01 3.12 0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function HeartIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 21.3 10.9 20.3C5.4 15.3 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.8 0 3.5.8 4.5 2.1C13 3.8 14.7 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.8-8.9 11.8L12 21.3Z" />
    </svg>
  );
}

export function PlayIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6.25 4.7a.75.75 0 0 1 1.14-.64l8.1 5.05a1.05 1.05 0 0 1 0 1.78l-8.1 5.05a.75.75 0 0 1-1.14-.64V4.7Z" />
    </svg>
  );
}

export function PauseIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6.25 4.5A1.25 1.25 0 0 1 7.5 3.25h.5a1.25 1.25 0 0 1 1.25 1.25v11A1.25 1.25 0 0 1 8 16.75h-.5a1.25 1.25 0 0 1-1.25-1.25v-11Zm4.5 0A1.25 1.25 0 0 1 12 3.25h.5a1.25 1.25 0 0 1 1.25 1.25v11A1.25 1.25 0 0 1 12.5 16.75H12a1.25 1.25 0 0 1-1.25-1.25v-11Z" />
    </svg>
  );
}

export function FolderIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M2.75 6.5A1.75 1.75 0 0 1 4.5 4.75h3L9.4 6.4h6.1a1.75 1.75 0 0 1 1.75 1.75v6.35a1.75 1.75 0 0 1-1.75 1.75h-11A1.75 1.75 0 0 1 2.75 14.5v-8Z" />
      <path d="M2.75 8h14.5" />
    </svg>
  );
}

export function EyeIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}

export function EyeOffIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.15 4.85A8.5 8.5 0 0 1 10 4.5c4.5 0 7.5 5.5 7.5 5.5a12.4 12.4 0 0 1-1.67 2.28" />
      <path d="M5.6 5.6A12.2 12.2 0 0 0 2.5 10s3 5.5 7.5 5.5a8.3 8.3 0 0 0 4.4-1.6" />
      <path d="M8.23 8.23a2.5 2.5 0 0 0 3.54 3.54" />
      <path d="M3 3l14 14" />
    </svg>
  );
}

export function PowerIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M10 3.25v5" />
      <path d="M6.1 5.15a6.25 6.25 0 1 0 7.8 0" />
    </svg>
  );
}

export function EditIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

export function CheckIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 12 4.25 4.25L19 6.5" />
    </svg>
  );
}

export function TrashIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4.75A1.75 1.75 0 0 1 9.75 3h4.5A1.75 1.75 0 0 1 16 4.75V6" />
      <path d="M18 6v12.25A1.75 1.75 0 0 1 16.25 20h-8.5A1.75 1.75 0 0 1 6 18.25V6" />
      <path d="M10 10.5v5" />
      <path d="M14 10.5v5" />
    </svg>
  );
}

export function CopyIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

export function EndpointIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7.25 5.75h-1.5A2.75 2.75 0 0 0 3 8.5v5.75A2.75 2.75 0 0 0 5.75 17h5.75a2.75 2.75 0 0 0 2.75-2.75v-1.5" />
      <path d="M10.5 9.5 17 3" />
      <path d="M12 3h5v5" />
    </svg>
  );
}

export function KeyIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="6.75" cy="10" r="3.25" />
      <path d="M10 10h6.5" />
      <path d="M13.5 10v2.25" />
      <path d="M15.75 10v1.5" />
    </svg>
  );
}

export function RotateIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.25 10a6.25 6.25 0 1 1-1.83-4.42" />
      <path d="M13.5 3.75h3v3" />
      <path d="M16.5 3.75 12.75 7.5" />
    </svg>
  );
}

export function FileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
      <path d="M7.75 11h4.5" />
      <path d="M7.75 14h4.5" />
    </svg>
  );
}

export function BackupFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3.5h5.25L15 7.25V16A1.5 1.5 0 0 1 13.5 17.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5H6Z" />
      <path d="M11 3.5V7.5H15" />
      <path d="M7 12.25a3 3 0 1 1 2.85 2.99" />
      <path d="M8.5 10.25h1.5v1.5" />
    </svg>
  );
}

export function SecretFileIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 2.75 4.75 5v4.12c0 3.42 2.1 6.58 5.25 7.88 3.15-1.3 5.25-4.46 5.25-7.88V5L10 2.75Z" />
      <circle cx="10" cy="9" r="1.4" />
      <path d="M10 10.4v2.1" />
    </svg>
  );
}
