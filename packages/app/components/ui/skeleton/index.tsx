import React, { forwardRef, useEffect, useState } from 'react';
import type { VariantProps } from '@gluestack-ui/nativewind-utils';
import { Animated, Easing, Platform, View } from 'react-native';
import { skeletonStyle, skeletonTextStyle } from './styles';

const PULSE_EASING = Easing.bezier(0.4, 0, 0.6, 1);
const FADE_DURATION = 0.6;

type ISkeletonProps = React.ComponentProps<typeof View> &
  VariantProps<typeof skeletonStyle> & {
    isLoaded?: boolean;
    startColor?: string;
  };

type ISkeletonTextProps = React.ComponentProps<typeof View> &
  VariantProps<typeof skeletonTextStyle> & {
    _lines?: number;
    isLoaded?: boolean;
    startColor?: string;
  };

const Skeleton = forwardRef<
  React.ElementRef<typeof View>,
  ISkeletonProps
>(
  (
    {
      className,
      variant,
      children,
      startColor = 'bg-background-200',
      isLoaded = false,
      speed = 2,
      ...props
    },
    ref
  ) => {
    const [pulseAnim] = useState(() => new Animated.Value(1));

    useEffect(() => {
      if (isLoaded) {
        return;
      }
      const animationDuration = (FADE_DURATION * 10000) / speed; // Convert seconds to milliseconds
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1, // Start with opacity 1
            duration: animationDuration / 2,
            easing: PULSE_EASING,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.75,
            duration: animationDuration / 2,
            easing: PULSE_EASING,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: animationDuration / 2,
            easing: PULSE_EASING,
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
      );
      pulse.start();

      return () => {
        pulse.stop();
      };
    }, [isLoaded, speed, pulseAnim]);

    if (!isLoaded) {
      return (
        <Animated.View
          style={{ opacity: pulseAnim }}
          className={`${startColor} ${skeletonStyle({
            variant,
            class: className,
          })}`}
          {...props}
          ref={ref}
        />
      );
    }

    return children;
  }
);

const SkeletonText = forwardRef<
  React.ElementRef<typeof View>,
  ISkeletonTextProps
>(
  (
    {
      className,
      _lines,
      isLoaded = false,
      startColor = 'bg-background-200',
      gap = 2,
      children,
      ...props
    },
    ref
  ) => {
    if (!isLoaded) {
      if (_lines) {
        return (
          <View
            className={`${skeletonTextStyle({
              gap,
            })}`}
            ref={ref}
          >
            {Array.from({ length: _lines }).map((_, index) => (
              <Skeleton
                key={index}
                className={`${startColor} ${skeletonTextStyle({
                  class: className,
                })}`}
                {...props}
              />
            ))}
          </View>
        );
      } else {
        return (
          <Skeleton
            className={`${startColor} ${skeletonTextStyle({
              class: className,
            })}`}
            {...props}
            ref={ref}
          />
        );
      }
    } else {
      return children;
    }
  }
);

Skeleton.displayName = 'Skeleton';
SkeletonText.displayName = 'SkeletonText';

export { Skeleton, SkeletonText };
