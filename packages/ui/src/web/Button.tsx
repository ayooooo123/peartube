import React from 'react';
import { Pressable, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { ButtonProps, getButtonStyles } from '../primitives';
import { colors } from '@peartube/shared';

export const Button: React.FC<ButtonProps> = (props) => {
  const { children, onPress, disabled, loading, variant = 'secondary' } = props;
  const styles = getButtonStyles(props);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        buttonStyles.base,
        {
          backgroundColor: styles.backgroundColor,
          borderRadius: styles.borderRadius,
          paddingVertical: styles.paddingVertical,
          paddingHorizontal: styles.paddingHorizontal,
          opacity: pressed ? 0.8 : styles.opacity,
          borderWidth: styles.borderWidth,
          borderColor: styles.borderColor,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : (
        <Text style={[buttonStyles.text, { fontSize: styles.fontSize, color: styles.color }]}>
          {children}
        </Text>
      )}
    </Pressable>
  );
};

const buttonStyles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
