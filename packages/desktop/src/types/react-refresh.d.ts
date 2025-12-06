declare module 'react-refresh/runtime' {
  const runtime: {
    injectIntoGlobalHook: (window: Window) => void;
    register: (type: any, id: string) => void;
    createSignatureFunctionForTransform: () => (type: any, key: string, forceReset?: boolean, getCustomHooks?: () => any[]) => any;
  };
  export default runtime;
}
