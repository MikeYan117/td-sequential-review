// Minimal stand-in for the host service's logger: only the methods the extracted code calls.
export interface Logger {
    info(message: string, meta?: object): void;
    warn(message: string, meta?: object): void;
    error(message: string, error?: Error, meta?: object): void;
}
