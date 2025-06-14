/// <reference types="svelte" />
import type { TaintedFields, SuperFormValidated, SuperValidated } from '../superValidate.js';
import type { ActionResult, Page, SubmitFunction } from '@sveltejs/kit';
import { type Readable, type Writable, type Updater } from 'svelte/store';
import { type FormPathType, type FormPath, type FormPathLeaves } from '../stringPath.js';
import { enhance as kitEnhance } from '$app/forms';
import type { ValidationErrors } from '../superValidate.js';
import type { MaybePromise } from '../utils.js';
import type { ClientValidationAdapter, ValidationAdapter } from '../adapters/adapters.js';
import type { InputConstraints } from '../jsonSchema/constraints.js';
import { type ProxyOptions } from './proxies.js';
export type SuperFormEvents<T extends Record<string, unknown>, M> = Pick<FormOptions<T, M>, 'onError' | 'onResult' | 'onSubmit' | 'onUpdate' | 'onUpdated'>;
export type SuperFormEventList<T extends Record<string, unknown>, M> = {
    [Property in keyof SuperFormEvents<T, M>]-?: NonNullable<SuperFormEvents<T, M>[Property]>[];
};
/**
 * Helper type for making onResult strongly typed with ActionData.
 * @example const result = event.result as FormResult<ActionData>;
 */
export type FormResult<T extends Record<string, unknown> | null> = ActionResult<NonNullable<T>, NonNullable<T>>;
export type TaintOption = boolean | 'untaint' | 'untaint-all' | 'untaint-form';
type ValidatorsOption<T extends Record<string, unknown>> = ValidationAdapter<Partial<T>, Record<string, unknown>> | false | 'clear';
export type FormOptions<T extends Record<string, unknown> = Record<string, unknown>, M = any, In extends Record<string, unknown> = T> = Partial<{
    id: string;
    applyAction: boolean;
    invalidateAll: boolean | 'force';
    resetForm: boolean | (() => boolean);
    scrollToError: 'auto' | 'smooth' | 'off' | boolean | ScrollIntoViewOptions;
    autoFocusOnError: boolean | 'detect';
    errorSelector: string;
    selectErrorText: boolean;
    stickyNavbar: string;
    taintedMessage: string | boolean | null | (() => MaybePromise<boolean>);
    SPA: true | {
        failStatus?: number;
    } | string;
    onSubmit: (input: Parameters<SubmitFunction>[0] & {
        /**
         * If dataType: 'json' is set, send this data instead of $form when posting,
         * and client-side validation for $form passes.
         * @param data An object that can be serialized with devalue.
         */
        jsonData: (data: Record<string, unknown>) => void;
        /**
         * Override client validation temporarily for this form submission.
         */
        validators: (validators: Exclude<ValidatorsOption<T>, 'clear'>) => void;
    }) => MaybePromise<unknown | void>;
    onResult: (event: {
        result: ActionResult;
        /**
         * @deprecated Use formElement instead
         */
        formEl: HTMLFormElement;
        formElement: HTMLFormElement;
        cancel: () => void;
    }) => MaybePromise<unknown | void>;
    onUpdate: (event: {
        form: SuperValidated<T, M, In>;
        /**
         * @deprecated Use formElement instead
         */
        formEl: HTMLFormElement;
        formElement: HTMLFormElement;
        cancel: () => void;
    }) => MaybePromise<unknown | void>;
    onUpdated: (event: {
        form: Readonly<SuperValidated<T, M, In>>;
    }) => MaybePromise<unknown | void>;
    onError: 'apply' | ((event: {
        result: {
            type: 'error';
            status?: number;
            error: App.Error | Error | {
                message: string;
            };
        };
    }) => MaybePromise<unknown | void>);
    onChange: (event: ChangeEvent<T>) => void;
    dataType: 'form' | 'json';
    jsonChunkSize: number;
    validators: ClientValidationAdapter<Partial<T>, Record<string, unknown>> | ValidatorsOption<T>;
    validationMethod: 'auto' | 'oninput' | 'onblur' | 'onsubmit' | 'submit-only';
    customValidity: boolean;
    clearOnSubmit: 'errors' | 'message' | 'errors-and-message' | 'none';
    delayMs: number;
    timeoutMs: number;
    multipleSubmits: 'prevent' | 'allow' | 'abort';
    syncFlashMessage?: boolean;
    flashMessage: {
        module: {
            getFlash(page: Readable<Page>): Writable<App.PageData['flash']>;
            updateFlash(page: Readable<Page>, update?: () => Promise<void>): Promise<boolean>;
        };
        onError?: (event: {
            result: {
                type: 'error';
                status?: number;
                error: App.Error;
            };
            flashMessage: Writable<App.PageData['flash']>;
        }) => MaybePromise<unknown | void>;
        cookiePath?: string;
        cookieName?: string;
    };
    warnings: {
        duplicateId?: boolean;
    };
    /**
     * Version 1 compatibilty mode if true.
     * Sets resetForm = false and taintedMessage = true.
     * Add define: { SUPERFORMS_LEGACY: true } to vite.config.ts to enable globally.
     */
    legacy: boolean;
}>;
export type SuperFormSnapshot<T extends Record<string, unknown>, M = App.Superforms.Message extends never ? any : App.Superforms.Message, In extends Record<string, unknown> = T> = SuperFormValidated<T, M, In> & {
    tainted: TaintedFields<T> | undefined;
};
type SuperFormData<T extends Record<string, unknown>> = {
    subscribe: Readable<T>['subscribe'];
    set(this: void, value: T, options?: {
        taint?: TaintOption;
    }): void;
    update(this: void, updater: Updater<T>, options?: {
        taint?: TaintOption;
    }): void;
};
type SuperFormErrors<T extends Record<string, unknown>> = {
    subscribe: Writable<ValidationErrors<T>>['subscribe'];
    set(this: void, value: ValidationErrors<T>, options?: {
        force?: boolean;
    }): void;
    update(this: void, updater: Updater<ValidationErrors<T>>, options?: {
        force?: boolean;
    }): void;
    clear: () => void;
};
type ResetOptions<T extends Record<string, unknown>> = {
    keepMessage?: boolean;
    data?: Partial<T>;
    newState?: Partial<T>;
    id?: string;
};
type Capture<T extends Record<string, unknown>, M = App.Superforms.Message extends never ? any : App.Superforms.Message> = [T] extends [T] ? () => SuperFormSnapshot<T, M> : never;
type Restore<T extends Record<string, unknown>, M = App.Superforms.Message extends never ? any : App.Superforms.Message> = (snapshot: SuperFormSnapshot<T, M>) => void;
export type SuperForm<T extends Record<string, unknown>, M = App.Superforms.Message extends never ? any : App.Superforms.Message> = {
    form: SuperFormData<T>;
    formId: Writable<string>;
    errors: SuperFormErrors<T>;
    constraints: Writable<InputConstraints<T>>;
    message: Writable<M | undefined>;
    tainted: Writable<TaintedFields<T> | undefined>;
    submitting: Readable<boolean>;
    delayed: Readable<boolean>;
    timeout: Readable<boolean>;
    posted: Readable<boolean>;
    allErrors: Readable<{
        path: string;
        messages: string[];
    }[]>;
    options: T extends T ? FormOptions<T, M> : never;
    enhance: (el: HTMLFormElement, events?: SuperFormEvents<T, M>) => ReturnType<typeof kitEnhance>;
    isTainted: (path?: T extends T ? FormPath<T> | TaintedFields<T> | boolean : never) => boolean;
    reset: (options?: ResetOptions<T>) => void;
    submit: (submitter?: HTMLElement | Event | EventTarget | null) => void;
    capture: Capture<T, M>;
    restore: T extends T ? Restore<T, M> : never;
    validate: <Out extends Partial<T> = T, Path extends FormPathLeaves<T> = FormPathLeaves<T>, In extends Record<string, unknown> = Record<string, unknown>>(path: Path, opts?: ValidateOptions<FormPathType<T, Path>, Out, In>) => Promise<string[] | undefined>;
    validateForm: <Out extends Partial<T> = T, In extends Record<string, unknown> = Record<string, unknown>>(opts?: {
        update?: boolean;
        schema?: ValidationAdapter<Out, In>;
        focusOnError?: boolean;
    }) => Promise<SuperFormValidated<T, M, In>>;
};
export type ValidateOptions<Value, Out extends Record<string, unknown>, In extends Record<string, unknown>> = Partial<{
    value: Value;
    update: boolean | 'errors' | 'value';
    taint: TaintOption;
    errors: string | string[];
    schema: ValidationAdapter<Out, In>;
}>;
export type ChangeEvent<T extends Record<string, unknown>> = {
    path: FormPath<T>;
    paths: FormPath<T>[];
    formElement: HTMLFormElement;
    target: Element;
    set: <Path extends FormPath<T>>(path: Path, value: FormPathType<T, Path>, options?: ProxyOptions) => void;
    get: <Path extends FormPath<T>>(path: Path) => FormPathType<T, Path>;
} | {
    target: undefined;
    paths: FormPath<T>[];
    set: <Path extends FormPath<T>>(path: Path, value: FormPathType<T, Path>, options?: ProxyOptions) => void;
    get: <Path extends FormPath<T>>(path: Path) => FormPathType<T, Path>;
};
/**
 * Initializes a SvelteKit form, for convenient handling of values, errors and sumbitting data.
 * @param {SuperValidated} form Usually data.form from PageData or defaults, but can also be an object with default values, but then constraints won't be available.
 * @param {FormOptions} formOptions Configuration for the form.
 * @returns {SuperForm} A SuperForm object that can be used in a Svelte component.
 * @DCI-context
 */
export declare function superForm<T extends Record<string, unknown> = Record<string, unknown>, M = App.Superforms.Message extends never ? any : App.Superforms.Message, In extends Record<string, unknown> = T>(form: SuperValidated<T, M, In> | T, formOptions?: FormOptions<T, M, In>): SuperForm<T, M>;
export {};
