import React from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { InputProps, getInputStyles } from '../primitives';
import { colors } from '@peartube/shared';

export const Input: React.FC<InputProps> = (props) => {
  const { placeholder, value, onChangeText, disabled } = props;
  const styles = getInputStyles(props);

  return (
    <TextInput
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      value={value}
      onChangeText={onChangeText}
      editable={!disabled}
      style={[
        inputStyles.base,
        {
          backgroundColor: styles.backgroundColor,
          color: styles.color,
          borderRadius: styles.borderRadius,
          borderWidth: styles.borderWidth,
          borderColor: styles.borderColor,
          paddingVertical: styles.paddingVertical,
          paddingHorizontal: styles.paddingHorizontal,
          fontSize: styles.fontSize,
          opacity: styles.opacity,
        },
      ]}
    />
  );
};

const inputStyles = StyleSheet.create({
  base: {
    outlineStyle: 'none',
  } as any,
});
