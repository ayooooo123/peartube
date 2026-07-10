import React, { useMemo } from 'react';
import { createIcon } from '@gluestack-ui/icon';
import { tva } from '@gluestack-ui/nativewind-utils/tva';
import { VariantProps } from '@gluestack-ui/nativewind-utils';

const accessClassName = (style: any) => {
  const obj = style[0];
  const keys = Object.keys(obj); //will return an array of keys
  return obj[keys[1]];
};

const Svg = React.forwardRef<
  React.ElementRef<'svg'>,
  React.ComponentPropsWithoutRef<'svg'>
>(({ style, className, ...props }, ref) => {
  const calculateClassName = useMemo(() => {
    return className === undefined ? accessClassName(style) : className;
  }, [className, style]);

  return <svg ref={ref} {...props} className={calculateClassName} />;
});

type IPrimitiveIcon = {
  height?: number | string;
  width?: number | string;
  fill?: string;
  color?: string;
  size?: number | string;
  stroke?: string;
  as?: React.ElementType;
  className?: string;
};

const PrimitiveIcon = React.forwardRef<
  React.ElementRef<'svg'>,
  React.ComponentPropsWithoutRef<'svg'> & IPrimitiveIcon
>(
  (
    {
      height,
      width,
      fill,
      color,
      size,
      stroke = 'currentColor',
      as: AsComp,
      ...props
    },
    ref
  ) => {
    const sizeProps = useMemo(() => {
      if (size) return { size };
      if (height && width) return { height, width };
      if (height) return { height };
      if (width) return { width };
      return {};
    }, [size, height, width]);

    const colorProps =
      stroke === 'currentColor' && color !== undefined ? color : stroke;

    if (AsComp) {
      return (
        <AsComp
          ref={ref}
          fill={fill}
          {...props}
          {...sizeProps}
          stroke={colorProps}
        />
      );
    }
    return (
      <Svg
        ref={ref}
        height={height}
        width={width}
        fill={fill}
        stroke={colorProps}
        {...props}
      />
    );
  }
);

export const UIIcon = createIcon({
  Root: PrimitiveIcon,
});

const iconStyle = tva({
  base: 'text-typography-950 fill-none',
  variants: {
    size: {
      '2xs': 'h-3 w-3',
      'xs': 'h-3.5 w-3.5',
      'sm': 'h-4 w-4',
      'md': 'h-[18px] w-[18px]',
      'lg': 'h-5 w-5',
      'xl': 'h-6 w-6',
    },
  },
});

export const Icon = React.forwardRef<
  React.ElementRef<typeof UIIcon>,
  React.ComponentPropsWithoutRef<typeof UIIcon> &
    VariantProps<typeof iconStyle> & {
      height?: number | string;
      width?: number | string;
    }
>(({ size = 'md', className, ...props }, ref) => {
  if (typeof size === 'number') {
    return (
      <UIIcon
        ref={ref}
        {...props}
        className={iconStyle({ class: className })}
        size={size}
      />
    );
  } else if (
    (props.height !== undefined || props.width !== undefined) &&
    size === undefined
  ) {
    return (
      <UIIcon
        ref={ref}
        {...props}
        className={iconStyle({ class: className })}
      />
    );
  }
  return (
    <UIIcon
      ref={ref}
      {...props}
      className={iconStyle({ size, class: className })}
    />
  );
});

type ParameterTypes = Omit<Parameters<typeof createIcon>[0], 'Root'>;

const createIconUI = ({ ...props }: ParameterTypes) => {
  const UIIcon = createIcon({ Root: Svg, ...props });

  return React.forwardRef<
    React.ElementRef<typeof UIIcon>,
    React.ComponentPropsWithoutRef<typeof UIIcon> &
      VariantProps<typeof iconStyle> & {
        height?: number | string;
        width?: number | string;
      }
  >(({ className, size, ...props }, ref) => {
    return (
      <UIIcon
        ref={ref}
        {...props}
        className={iconStyle({ size, class: className })}
      />
    );
  });
};
export { createIconUI as createIcon };

// All Icons
const AddIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 5V19"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 12H19"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

AddIcon.displayName = 'AddIcon';
export { AddIcon };

const AlertCircleIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 8V12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 16H12.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

AlertCircleIcon.displayName = 'AlertCircleIcon';
export { AlertCircleIcon };

const ArrowUpIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 19V5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 12L12 5L19 12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ArrowDownIcon = createIcon({
  Root: Svg,

  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 5V19"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 12L12 19L5 12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ArrowRightIcon = createIcon({
  Root: Svg,

  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M5 12H19"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 5L19 12L12 19"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ArrowLeftIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M19 12H5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 19L5 12L12 5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

ArrowUpIcon.displayName = 'ArrowUpIcon';
ArrowDownIcon.displayName = 'ArrowDownIcon';
ArrowRightIcon.displayName = 'ArrowRightIcon';
ArrowLeftIcon.displayName = 'ArrowLeftIcon';

export { ArrowUpIcon, ArrowDownIcon, ArrowRightIcon, ArrowLeftIcon };

const AtSignIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <>
        <path
          d="M12 16C14.21 16 16 14.21 16 12C16 9.79 14.21 8 12 8C9.79 8 8 9.79 8 12C8 14.21 9.79 16 12 16Z"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 8V13C16 13.8 16.32 14.56 16.88 15.12C17.44 15.68 18.2 16 19 16C19.8 16 20.56 15.68 21.12 15.12C21.68 14.56 22 13.8 22 13V12C22 9.74 21.24 7.55 19.83 5.78C18.43 4.02 16.47 2.78 14.27 2.26C12.07 1.75 9.77 2 7.73 2.96C5.69 3.92 4.03 5.55 3.03 7.57C2.03 9.6 1.75 11.9 2.22 14.11C2.7 16.31 3.91 18.29 5.65 19.73C7.39 21.16 9.57 21.96 11.83 22C14.08 22.04 16.29 21.31 18.08 19.94"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    </>
  ),
});

AtSignIcon.displayName = 'AtSignIcon';

export { AtSignIcon };

const BellIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M18 8C18 6.41 17.37 4.88 16.24 3.76C15.12 2.63 13.59 2 12 2C10.41 2 8.88 2.63 7.76 3.76C6.63 4.88 6 6.41 6 8C6 15 3 17 3 17H21C21 17 18 15 18 8Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.73 21C13.55 21.3 13.3 21.55 13 21.73C12.69 21.9 12.35 22 12 22C11.65 22 11.31 21.9 11 21.73C10.7 21.55 10.45 21.3 10.27 21"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

BellIcon.displayName = 'BellIcon';

export { BellIcon };

const CalendarDaysIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M19 4H5C3.9 4 3 4.9 3 6V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V6C21 4.9 20.1 4 19 4Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 2V6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 2V6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 10H21"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 14H8.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 14H12.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 14H16.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 18H8.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 18H12.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 18H16.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

CalendarDaysIcon.displayName = 'CalendarDaysIcon';

export { CalendarDaysIcon };

const CheckIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M20 6L9 17L4 12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const CheckCircleIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 12L11 14L15 10"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

CheckIcon.displayName = 'CheckIcon';
CheckCircleIcon.displayName = 'CheckCircleIcon';

export { CheckIcon, CheckCircleIcon };

const ChevronUpIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  d: 'M12 10L8 6L4 10',
  path: (
    <>
      <path
        d="M18 15L12 9L6 15"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ChevronDownIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M6 9L12 15L18 9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ChevronLeftIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M15 18L9 12L15 6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ChevronRightIcon = createIcon({
  Root: Svg,

  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M9 18L15 12L9 6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ChevronsLeftIcon = createIcon({
  Root: Svg,

  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M11 17L6 12L11 7"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 17L13 12L18 7"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ChevronsRightIcon = createIcon({
  Root: Svg,

  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M13 17L18 12L13 7"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 17L11 12L6 7"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const ChevronsUpDownIcon = createIcon({
  Root: Svg,

  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M7 15L12 20L17 15"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 9L12 4L17 9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

ChevronUpIcon.displayName = 'ChevronUpIcon';
ChevronDownIcon.displayName = 'ChevronDownIcon';
ChevronLeftIcon.displayName = 'ChevronLeftIcon';
ChevronRightIcon.displayName = 'ChevronRightIcon';
ChevronsLeftIcon.displayName = 'ChevronsLeftIcon';
ChevronsRightIcon.displayName = 'ChevronsRightIcon';
ChevronsUpDownIcon.displayName = 'ChevronsUpDownIcon';

export {
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronsUpDownIcon,
};

const CircleIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

CircleIcon.displayName = 'CircleIcon';
export { CircleIcon };

const ClockIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 6V12L16 14"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

ClockIcon.displayName = 'ClockIcon';

export { ClockIcon };

const CloseIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M18 6L6 18"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 6L18 18"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

const CloseCircleIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 9L9 15"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 9L15 15"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

CloseIcon.displayName = 'CloseIcon';
CloseCircleIcon.displayName = 'CloseCircleIcon';

export { CloseIcon, CloseCircleIcon };

const CopyIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M20 9H11C9.9 9 9 9.9 9 11V20C9 21.1 9.9 22 11 22H20C21.1 22 22 21.1 22 20V11C22 9.9 21.1 9 20 9Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 15H4C3.47 15 2.96 14.79 2.59 14.41C2.21 14.04 2 13.53 2 13V4C2 3.47 2.21 2.96 2.59 2.59C2.96 2.21 3.47 2 4 2H13C13.53 2 14.04 2.21 14.41 2.59C14.79 2.96 15 3.47 15 4V5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

CopyIcon.displayName = 'CopyIcon';

export { CopyIcon };

const DownloadIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M21 15V19C21 19.53 20.79 20.04 20.41 20.41C20.04 20.79 19.53 21 19 21H5C4.47 21 3.96 20.79 3.59 20.41C3.21 20.04 3 19.53 3 19V15"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 10L12 15L17 10"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 15V3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

DownloadIcon.displayName = 'DownloadIcon';
export { DownloadIcon };

const EditIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M11 4H4C3.47 4 2.96 4.21 2.59 4.59C2.21 4.96 2 5.47 2 6V20C2 20.53 2.21 21.04 2.59 21.41C2.96 21.79 3.47 22 4 22H18C18.53 22 19.04 21.79 19.41 21.41C19.79 21.04 20 20.53 20 20V13"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 2.5C18.9 2.1 19.44 1.88 20 1.88C20.56 1.88 21.1 2.1 21.5 2.5C21.9 2.9 22.12 3.44 22.12 4C22.12 4.56 21.9 5.1 21.5 5.5L12 15L8 16L9 12L18.5 2.5Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

EditIcon.displayName = 'EditIcon';
export { EditIcon };

const EyeIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M2 12C2 12 5 5 12 5C19 5 22 12 22 12C22 12 19 19 12 19C5 19 2 12 2 12Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 15C13.66 15 15 13.66 15 12C15 10.34 13.66 9 12 9C10.34 9 9 10.34 9 12C9 13.66 10.34 15 12 15Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

EyeIcon.displayName = 'EyeIcon';

const EyeOffIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M9.88 9.88C9.59 10.15 9.35 10.49 9.18 10.85C9.02 11.22 8.93 11.62 8.93 12.02C8.92 12.42 8.99 12.82 9.14 13.2C9.29 13.57 9.52 13.91 9.8 14.2C10.09 14.48 10.43 14.71 10.8 14.86C11.18 15.01 11.58 15.08 11.98 15.07C12.38 15.07 12.78 14.98 13.15 14.82C13.51 14.65 13.85 14.41 14.12 14.12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.73 5.08C11.15 5.03 11.58 5 12 5C19 5 22 12 22 12C21.55 12.96 20.99 13.86 20.33 14.68"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.61 6.61C4.62 7.96 3.03 9.83 2 12C2 12 5 19 12 19C13.92 19.01 15.79 18.45 17.39 17.39"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 2L22 22"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

EyeOffIcon.displayName = 'EyeOffIcon';
export { EyeIcon, EyeOffIcon };

const FavouriteIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M20.42 4.58C19.92 4.08 19.32 3.68 18.67 3.4C18.01 3.13 17.31 2.99 16.59 2.99C15.88 2.99 15.18 3.13 14.52 3.4C13.87 3.68 13.27 4.08 12.77 4.58L12 5.36L11.23 4.58C10.73 4.08 10.13 3.68 9.48 3.4C8.82 3.13 8.12 2.99 7.4 2.99C6.69 2.99 5.99 3.13 5.33 3.4C4.68 3.68 4.08 4.08 3.58 4.58C1.46 6.7 1.33 10.28 4 13L12 21L20 13C22.67 10.28 22.54 6.7 20.42 4.58Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

FavouriteIcon.displayName = 'FavouriteIcon';
export { FavouriteIcon };

const GlobeIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 12H22"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 2C14.5 4.74 15.92 8.29 16 12C15.92 15.71 14.5 19.26 12 22C9.5 19.26 8.08 15.71 8 12C8.08 8.29 9.5 4.74 12 2V2Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

GlobeIcon.displayName = 'GlobeIcon';
export { GlobeIcon };

const GripVerticalIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M9 13C9.55 13 10 12.55 10 12C10 11.45 9.55 11 9 11C8.45 11 8 11.45 8 12C8 12.55 8.45 13 9 13Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 6C9.55 6 10 5.55 10 5C10 4.45 9.55 4 9 4C8.45 4 8 4.45 8 5C8 5.55 8.45 6 9 6Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 20C9.55 20 10 19.55 10 19C10 18.45 9.55 18 9 18C8.45 18 8 18.45 8 19C8 19.55 8.45 20 9 20Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 13C15.55 13 16 12.55 16 12C16 11.45 15.55 11 15 11C14.45 11 14 11.45 14 12C14 12.55 14.45 13 15 13Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 6C15.55 6 16 5.55 16 5C16 4.45 15.55 4 15 4C14.45 4 14 4.45 14 5C14 5.55 14.45 6 15 6Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 20C15.55 20 16 19.55 16 19C16 18.45 15.55 18 15 18C14.45 18 14 18.45 14 19C14 19.55 14.45 20 15 20Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

GripVerticalIcon.displayName = 'GripVerticalIcon';
export { GripVerticalIcon };

const HelpCircleIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.09 9C9.33 8.33 9.79 7.77 10.4 7.41C11.01 7.05 11.73 6.92 12.43 7.04C13.13 7.16 13.76 7.52 14.22 8.06C14.67 8.61 14.92 9.29 14.92 10C14.92 12 11.92 13 11.92 13"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 17H12.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

HelpCircleIcon.displayName = 'HelpCircleIcon';
export { HelpCircleIcon };

const InfoIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 16V12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 8H12.01"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

InfoIcon.displayName = 'InfoIcon';
export { InfoIcon };

const LinkIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M10 13C10.43 13.57 10.98 14.05 11.61 14.39C12.24 14.74 12.93 14.94 13.65 14.99C14.36 15.04 15.08 14.94 15.75 14.69C16.42 14.44 17.03 14.05 17.54 13.54L20.54 10.54C21.45 9.6 21.95 8.33 21.94 7.02C21.93 5.71 21.41 4.46 20.48 3.53C19.55 2.6 18.3 2.08 16.99 2.07C15.68 2.06 14.41 2.56 13.47 3.47L11.75 5.18"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 11C13.57 10.43 13.02 9.95 12.39 9.61C11.76 9.26 11.07 9.06 10.35 9.01C9.64 8.96 8.92 9.06 8.25 9.31C7.58 9.56 6.97 9.95 6.46 10.46L3.46 13.46C2.55 14.4 2.05 15.67 2.06 16.98C2.07 18.29 2.59 19.54 3.52 20.47C4.45 21.4 5.7 21.92 7.01 21.93C8.32 21.94 9.59 21.44 10.53 20.53L12.24 18.82"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

LinkIcon.displayName = 'LinkIcon';

const ExternalLinkIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M18 13V19C18 19.53 17.79 20.04 17.41 20.41C17.04 20.79 16.53 21 16 21H5C4.47 21 3.96 20.79 3.59 20.41C3.21 20.04 3 19.53 3 19V8C3 7.47 3.21 6.96 3.59 6.59C3.96 6.21 4.47 6 5 6H11"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 3H21V9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 14L21 3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

ExternalLinkIcon.displayName = 'ExternalLinkIcon';
export { LinkIcon, ExternalLinkIcon };

const LoaderIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M21 12C21 13.9 20.4 15.75 19.28 17.29C18.16 18.83 16.59 19.97 14.78 20.56C12.97 21.15 11.03 21.15 9.22 20.56C7.41 19.97 5.84 18.83 4.72 17.29C3.6 15.75 3 13.9 3 12C3 10.1 3.6 8.25 4.72 6.71C5.84 5.17 7.41 4.03 9.22 3.44C11.03 2.85 12.97 2.85 14.78 3.44"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

LoaderIcon.displayName = 'LoaderIcon';
export { LoaderIcon };

const LockIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 11V7C7 5.67 7.53 4.4 8.46 3.46C9.4 2.53 10.67 2 12 2C13.33 2 14.6 2.53 15.54 3.46C16.47 4.4 17 5.67 17 7V11"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

LockIcon.displayName = 'LockIcon';
export { LockIcon };

const MailIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M20 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6C22 4.9 21.1 4 20 4Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 7L13.03 12.7C12.72 12.89 12.36 13 12 13C11.64 13 11.28 12.89 10.97 12.7L2 7"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

MailIcon.displayName = 'MailIcon';
export { MailIcon };

const MenuIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M4 12H20"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 6H20"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 18H20"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

MenuIcon.displayName = 'MenuIcon';
export { MenuIcon };

const MessageCircleIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M21 11.5C21 12.82 20.7 14.12 20.1 15.3C19.39 16.71 18.31 17.9 16.97 18.73C15.63 19.56 14.08 20 12.5 20C11.18 20 9.88 19.7 8.7 19.1L3 21L4.9 15.3C4.3 14.12 4 12.82 4 11.5C4 9.92 4.44 8.37 5.27 7.03C6.1 5.69 7.29 4.61 8.7 3.9C9.88 3.3 11.18 3 12.5 3H13C15.08 3.11 17.05 3.99 18.53 5.47C20.01 6.95 20.89 8.92 21 11V11.5Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

MessageCircleIcon.displayName = 'MessageCircleIcon';

export { MessageCircleIcon };

const MoonIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 3C10.81 4.19 10.15 5.81 10.15 7.5C10.15 9.18 10.82 10.79 12.02 11.98C13.21 13.18 14.82 13.85 16.5 13.85C18.19 13.85 19.81 13.19 21 12C21 13.78 20.47 15.52 19.48 17C18.49 18.48 17.09 19.63 15.44 20.31C13.8 21 11.99 21.17 10.24 20.83C8.5 20.48 6.89 19.62 5.64 18.36C4.38 17.11 3.52 15.5 3.17 13.76C2.83 12.01 3 10.2 3.69 8.56C4.37 6.91 5.52 5.51 7 4.52C8.48 3.53 10.22 3 12 3V3Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

MoonIcon.displayName = 'MoonIcon';
export { MoonIcon };

const PaperclipIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M21.44 11.05L12.25 20.24C11.12 21.37 9.6 22 8.01 22C6.41 22 4.89 21.37 3.76 20.24C2.63 19.11 2 17.59 2 15.99C2 14.4 2.63 12.88 3.76 11.75L12.33 3.18C13.08 2.43 14.1 2.01 15.16 2C16.22 2 17.24 2.42 18 3.17C18.75 3.93 19.17 4.94 19.17 6.01C19.17 7.07 18.75 8.09 18 8.84L9.41 17.41C9.03 17.79 8.53 18 8 18C7.46 18 6.96 17.79 6.58 17.41C6.2 17.03 5.99 16.53 5.99 15.99C5.99 15.46 6.2 14.96 6.58 14.58L15.07 6.1"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

PaperclipIcon.displayName = 'PaperclipIcon';
export { PaperclipIcon };

const PhoneIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M22 16.92V19.92C22 20.2 21.94 20.47 21.83 20.73C21.72 20.98 21.56 21.21 21.35 21.4C21.15 21.59 20.9 21.73 20.64 21.82C20.38 21.91 20.1 21.95 19.82 21.92C16.74 21.59 13.79 20.53 11.19 18.85C8.77 17.31 6.73 15.27 5.19 12.85C3.5 10.24 2.45 7.27 2.12 4.18C2.1 3.9 2.13 3.62 2.22 3.36C2.31 3.1 2.45 2.86 2.63 2.65C2.82 2.45 3.05 2.28 3.3 2.17C3.56 2.06 3.83 2 4.11 2H7.11C7.6 2 8.07 2.17 8.43 2.48C8.8 2.8 9.04 3.24 9.11 3.72C9.24 4.68 9.47 5.62 9.81 6.53C9.94 6.89 9.97 7.28 9.89 7.65C9.81 8.02 9.63 8.37 9.36 8.64L8.09 9.91C9.51 12.41 11.59 14.49 14.09 15.91L15.36 14.64C15.63 14.37 15.98 14.19 16.35 14.11C16.72 14.03 17.11 14.06 17.47 14.19C18.38 14.53 19.32 14.76 20.28 14.89C20.77 14.96 21.21 15.2 21.53 15.58C21.84 15.95 22.01 16.43 22 16.92Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

PhoneIcon.displayName = 'PhoneIcon';
export { PhoneIcon };

const PlayIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 8L16 12L10 16V8Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

PlayIcon.displayName = 'PlayIcon';
export { PlayIcon };

const RemoveIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M5 12H19"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

RemoveIcon.displayName = 'RemoveIcon';
export { RemoveIcon };

const RepeatIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M17 2L21 6L17 10"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 11V10C3 8.94 3.42 7.92 4.17 7.17C4.92 6.42 5.94 6 7 6H21"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 22L3 18L7 14"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 13V14C21 15.06 20.58 16.08 19.83 16.83C19.08 17.58 18.06 18 17 18H3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

RepeatIcon.displayName = 'RepeatIcon';

const Repeat1Icon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M17 2L21 6L17 10"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 11V10C3 8.94 3.42 7.92 4.17 7.17C4.92 6.42 5.94 6 7 6H21"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 22L3 18L7 14"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 13V14C21 15.06 20.58 16.08 19.83 16.83C19.08 17.58 18.06 18 17 18H3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 10H12V14"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

Repeat1Icon.displayName = 'Repeat1Icon';
export { RepeatIcon, Repeat1Icon };

const SearchIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M11 19C15.42 19 19 15.42 19 11C19 6.58 15.42 3 11 3C6.58 3 3 6.58 3 11C3 15.42 6.58 19 11 19Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 21L16.65 16.65"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

SearchIcon.displayName = 'SearchIcon';
export { SearchIcon };

const SettingsIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12.22 2H11.78C11.25 2 10.74 2.21 10.37 2.59C9.99 2.96 9.78 3.47 9.78 4V4.18C9.78 4.53 9.69 4.88 9.51 5.18C9.34 5.48 9.08 5.73 8.78 5.91L8.35 6.16C8.05 6.34 7.7 6.43 7.35 6.43C7 6.43 6.65 6.34 6.35 6.16L6.2 6.08C5.74 5.82 5.2 5.74 4.68 5.88C4.17 6.02 3.74 6.35 3.47 6.81L3.25 7.19C2.99 7.65 2.91 8.19 3.05 8.71C3.19 9.22 3.52 9.65 3.98 9.92L4.13 10.02C4.43 10.19 4.68 10.45 4.86 10.75C5.03 11.05 5.13 11.39 5.13 11.74V12.25C5.13 12.6 5.04 12.95 4.86 13.25C4.69 13.56 4.44 13.81 4.13 13.99L3.98 14.08C3.52 14.35 3.19 14.78 3.05 15.29C2.91 15.81 2.99 16.35 3.25 16.81L3.47 17.19C3.74 17.65 4.17 17.98 4.68 18.12C5.2 18.26 5.74 18.18 6.2 17.92L6.35 17.84C6.65 17.66 7 17.57 7.35 17.57C7.7 17.57 8.05 17.66 8.35 17.84L8.78 18.09C9.08 18.27 9.34 18.52 9.51 18.82C9.69 19.12 9.78 19.47 9.78 19.82V20C9.78 20.53 9.99 21.04 10.37 21.41C10.74 21.79 11.25 22 11.78 22H12.22C12.75 22 13.26 21.79 13.63 21.41C14.01 21.04 14.22 20.53 14.22 20V19.82C14.22 19.47 14.31 19.12 14.49 18.82C14.66 18.52 14.92 18.27 15.22 18.09L15.65 17.84C15.95 17.66 16.3 17.57 16.65 17.57C17 17.57 17.35 17.66 17.65 17.84L17.8 17.92C18.26 18.18 18.8 18.26 19.32 18.12C19.83 17.98 20.26 17.65 20.53 17.19L20.75 16.8C21.01 16.34 21.09 15.8 20.95 15.28C20.81 14.77 20.48 14.34 20.02 14.07L19.87 13.99C19.56 13.81 19.31 13.56 19.14 13.25C18.96 12.95 18.87 12.6 18.87 12.25V11.75C18.87 11.4 18.96 11.05 19.14 10.75C19.31 10.44 19.56 10.19 19.87 10.01L20.02 9.92C20.48 9.65 20.81 9.22 20.95 8.71C21.09 8.19 21.01 7.65 20.75 7.19L20.53 6.81C20.26 6.35 19.83 6.02 19.32 5.88C18.8 5.74 18.26 5.82 17.8 6.08L17.65 6.16C17.35 6.34 17 6.43 16.65 6.43C16.3 6.43 15.95 6.34 15.65 6.16L15.22 5.91C14.92 5.73 14.66 5.48 14.49 5.18C14.31 4.88 14.22 4.53 14.22 4.18V4C14.22 3.47 14.01 2.96 13.63 2.59C13.26 2.21 12.75 2 12.22 2V2Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 15C13.66 15 15 13.66 15 12C15 10.34 13.66 9 12 9C10.34 9 9 10.34 9 12C9 13.66 10.34 15 12 15Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

SettingsIcon.displayName = 'SettingsIcon';
export { SettingsIcon };

const ShareIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M18 8C19.66 8 21 6.66 21 5C21 3.34 19.66 2 18 2C16.34 2 15 3.34 15 5C15 6.66 16.34 8 18 8Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 15C7.66 15 9 13.66 9 12C9 10.34 7.66 9 6 9C4.34 9 3 10.34 3 12C3 13.66 4.34 15 6 15Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 22C19.66 22 21 20.66 21 19C21 17.34 19.66 16 18 16C16.34 16 15 17.34 15 19C15 20.66 16.34 22 18 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.59 13.51L15.42 17.49"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.41 6.51L8.59 10.49"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

ShareIcon.displayName = 'ShareIcon';
export { ShareIcon };

const SlashIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.93 4.93L19.07 19.07"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

SlashIcon.displayName = 'SlashIcon';
export { SlashIcon };

const StarIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

StarIcon.displayName = 'StarIcon';
export { StarIcon };

const SunIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 16C14.21 16 16 14.21 16 12C16 9.79 14.21 8 12 8C9.79 8 8 9.79 8 12C8 14.21 9.79 16 12 16Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 2V4"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 20V22"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.93 4.93L6.34 6.34"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17.66 17.66L19.07 19.07"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 12H4"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 12H22"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.34 17.66L4.93 19.07"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19.07 4.93L17.66 6.34"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

SunIcon.displayName = 'SunIcon';
export { SunIcon };

const ThreeDotsIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M12 13C12.55 13 13 12.55 13 12C13 11.45 12.55 11 12 11C11.45 11 11 11.45 11 12C11 12.55 11.45 13 12 13Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 13C19.55 13 20 12.55 20 12C20 11.45 19.55 11 19 11C18.45 11 18 11.45 18 12C18 12.55 18.45 13 19 13Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 13C5.55 13 6 12.55 6 12C6 11.45 5.55 11 5 11C4.45 11 4 11.45 4 12C4 12.55 4.45 13 5 13Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

ThreeDotsIcon.displayName = 'ThreeDotsIcon';
export { ThreeDotsIcon };

const TrashIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M3 6H21"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 6V20C19 21 18 22 17 22H7C6 22 5 21 5 20V6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 6V4C8 3 9 2 10 2H14C15 2 16 3 16 4V6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

TrashIcon.displayName = 'TrashIcon';
export { TrashIcon };

const UnlockIcon = createIcon({
  Root: Svg,
  viewBox: '0 0 24 24',
  path: (
    <>
      <path
        d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 11V7C7 5.76 7.46 4.56 8.29 3.64C9.12 2.72 10.26 2.14 11.5 2.02C12.73 1.9 13.97 2.23 14.97 2.97C15.96 3.7 16.65 4.78 16.9 6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
});

UnlockIcon.displayName = 'UnlockIcon';
export { UnlockIcon };
