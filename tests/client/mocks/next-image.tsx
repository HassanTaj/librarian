import type { ImgHTMLAttributes } from 'react';

export default function TestImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  // eslint-disable-next-line @next/next/no-img-element -- Keep the Vitest stub independent of Next's image optimizer.
  return <img alt={props.alt ?? ''} {...props} />;
}
