interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 20, className }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="as-grad" x1="22" y1="22" x2="98" y2="98" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      {/* Outer scope ring */}
      <circle cx="60" cy="60" r="46" stroke="url(#as-grad)" strokeWidth="6" />
      {/* Inner ring */}
      <circle cx="60" cy="60" r="26" stroke="url(#as-grad)" strokeWidth="3" opacity="0.5" />
      {/* Transaction pulse waveform */}
      <path
        d="M22 60 L44 60 L50 44 L60 76 L68 50 L76 60 L98 60"
        stroke="url(#as-grad)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Crosshair ticks */}
      <g stroke="#ffffff" strokeWidth="4" strokeLinecap="round">
        <line x1="60" y1="6" x2="60" y2="16" />
        <line x1="60" y1="104" x2="60" y2="114" />
        <line x1="6" y1="60" x2="16" y2="60" />
        <line x1="104" y1="60" x2="114" y2="60" />
      </g>
    </svg>
  );
}
