import React from "react";

/** Scribase Mail mark: monochrome envelope on a rounded square. */
export const Logo: React.FC<React.SVGProps<SVGSVGElement>> = ({ ...props }) => {
  return (
    <svg
      width="650"
      height="650"
      viewBox="0 0 650 650"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Scribase Mail"
      {...props}
    >
      <rect width="650" height="650" rx="150" fill="#0A0A0A" />
      <rect
        x="150"
        y="205"
        width="350"
        height="240"
        rx="36"
        stroke="#FFFFFF"
        strokeWidth="34"
      />
      <path
        d="M170 235 L325 345 L480 235"
        stroke="#FFFFFF"
        strokeWidth="34"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default Logo;
