import React from 'react'
import { StyleSheet } from 'react-native'
import {
  Button as ExpoButton,
  Switch as ExpoSwitch,
  TextInput as ExpoTextInput,
  type ButtonProps as ExpoButtonProps,
  type SwitchProps as ExpoSwitchProps,
  type TextInputProps as ExpoTextInputProps,
} from '@expo/ui'

export type NativeButtonProps = ExpoButtonProps & {
  className?: string
}

export function NativeButton({ style, className: _className, ...props }: NativeButtonProps) {
  return <ExpoButton {...props} style={[styles.button, style]} />
}

export type NativeSwitchProps = ExpoSwitchProps & {
  className?: string
  trackColor?: { false?: string; true?: string }
  thumbColor?: string
}

export function NativeSwitch({ className: _className, trackColor: _trackColor, thumbColor: _thumbColor, ...props }: NativeSwitchProps) {
  return <ExpoSwitch {...props} />
}

export type NativeTextInputProps = ExpoTextInputProps & {
  className?: string
  textAlignVertical?: 'auto' | 'top' | 'center' | 'bottom'
}

export function NativeTextInput({ style, textStyle, className: _className, textAlignVertical: _textAlignVertical, ...props }: NativeTextInputProps) {
  return <ExpoTextInput {...props} style={[styles.input, style]} textStyle={[styles.text, textStyle]} />
}

export {
  Host as NativeHost,
  Row as NativeRow,
  Column as NativeColumn,
  Spacer as NativeSpacer,
  Text as NativeText,
  type TextInputRef as NativeTextInputRef,
  useNativeState,
} from '@expo/ui'

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
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
