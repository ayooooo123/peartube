import React from 'react'
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type PressableProps,
  type StyleProp,
  type SwitchProps,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { colors } from '@/lib/colors'

// Plain React Native replacements for the former @expo/ui pilot widgets.
// @expo/ui pulled the whole Jetpack Compose runtime (~MBs of dex) into the
// Android APK for three trivial controls, so the pilot was rolled back.

export type NativeButtonProps = Omit<PressableProps, 'style'> & {
  label: string
  variant?: 'filled' | 'outlined'
  style?: StyleProp<ViewStyle>
  className?: string
}

export function NativeButton({ label, variant = 'filled', style, disabled, className: _className, ...props }: NativeButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      {...props}
      style={({ pressed }) => [
        styles.button,
        variant === 'filled' ? styles.buttonFilled : styles.buttonOutlined,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, variant === 'filled' ? styles.buttonLabelFilled : styles.buttonLabelOutlined]}>
        {label}
      </Text>
    </Pressable>
  )
}

export type NativeSwitchProps = SwitchProps & {
  className?: string
}

export function NativeSwitch({ className: _className, ...props }: NativeSwitchProps) {
  return <Switch {...props} />
}

export type NativeTextInputProps = TextInputProps & {
  className?: string
  textStyle?: StyleProp<TextStyle>
}

export function NativeTextInput({ style, textStyle, className, ...props }: NativeTextInputProps) {
  // Call sites style via nativewind `className`; only apply the fallback
  // styles when no className is provided.
  return (
    <TextInput
      className={className}
      {...props}
      style={[!className && styles.input, styles.text, style, textStyle]}
    />
  )
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonFilled: {
    backgroundColor: colors.primary,
  },
  buttonOutlined: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  buttonLabelFilled: {
    color: colors.text,
  },
  buttonLabelOutlined: {
    color: colors.text,
  },
  input: {
    minHeight: 48,
    marginBottom: 12,
    backgroundColor: '#111827',
    borderColor: '#243041',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text: {
    color: '#f8fafc',
    fontSize: 16,
  },
})
