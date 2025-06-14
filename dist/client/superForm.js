import { derived, get, readonly, writable } from 'svelte/store';
import { navigating, page } from '$app/stores';
import { clone } from '../utils.js';
import { browser } from '$app/environment';
import { onDestroy, tick } from 'svelte';
import { comparePaths, pathExists, setPaths, traversePath, traversePaths } from '../traversal.js';
import { splitPath, mergePath } from '../stringPath.js';
import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
import { SuperFormError, flattenErrors, mapErrors, updateErrors } from '../errors.js';
import { cancelFlash, shouldSyncFlash } from './flash.js';
import { applyAction, enhance as kitEnhance } from '$app/forms';
import { setCustomValidityForm, updateCustomValidity } from './customValidity.js';
import { inputInfo } from './elements.js';
import { Form as HtmlForm, scrollToFirstError } from './form.js';
import { stringify } from 'devalue';
import { fieldProxy } from './proxies.js';
import { shapeFromObject } from '../jsonSchema/schemaShape.js';
const formIds = new WeakMap();
const initialForms = new WeakMap();
const defaultOnError = (event) => {
    console.warn('Unhandled error caught by Superforms, use onError event to handle it:', event.result.error);
};
const defaultFormOptions = {
    applyAction: true,
    invalidateAll: true,
    resetForm: true,
    autoFocusOnError: 'detect',
    scrollToError: 'smooth',
    errorSelector: '[aria-invalid="true"],[data-invalid]',
    selectErrorText: false,
    stickyNavbar: undefined,
    taintedMessage: false,
    onSubmit: undefined,
    onResult: undefined,
    onUpdate: undefined,
    onUpdated: undefined,
    onError: defaultOnError,
    dataType: 'form',
    validators: undefined,
    customValidity: false,
    clearOnSubmit: 'message',
    delayMs: 500,
    timeoutMs: 8000,
    multipleSubmits: 'prevent',
    SPA: undefined,
    validationMethod: 'auto'
};
function multipleFormIdError(id) {
    return (`Duplicate form id's found: "${id}". ` +
        'Multiple forms will receive the same data. Use the id option to differentiate between them, ' +
        'or if this is intended, set the warnings.duplicateId option to false in superForm to disable this warning. ' +
        'More information: https://superforms.rocks/concepts/multiple-forms');
}
/////////////////////////////////////////////////////////////////////
/**
 * V1 compatibilty. resetForm = false and taintedMessage = true
 */
let LEGACY_MODE = false;
try {
    // @ts-expect-error Vite define check
    if (SUPERFORMS_LEGACY)
        LEGACY_MODE = true;
}
catch {
    // No legacy mode defined
}
/**
 * Storybook compatibility mode, basically disables the navigating store.
 */
let STORYBOOK_MODE = false;
try {
    // @ts-expect-error Storybook check
    if (globalThis.STORIES)
        STORYBOOK_MODE = true;
}
catch {
    // No Storybook
}
/////////////////////////////////////////////////////////////////////
/**
 * Initializes a SvelteKit form, for convenient handling of values, errors and sumbitting data.
 * @param {SuperValidated} form Usually data.form from PageData or defaults, but can also be an object with default values, but then constraints won't be available.
 * @param {FormOptions} formOptions Configuration for the form.
 * @returns {SuperForm} A SuperForm object that can be used in a Svelte component.
 * @DCI-context
 */
export function superForm(form, formOptions) {
    // Used in reset
    let initialForm;
    let options = formOptions ?? {};
    // To check if a full validator is used when switching options.validators dynamically
    let initialValidator = undefined;
    {
        if (options.legacy ?? LEGACY_MODE) {
            if (options.resetForm === undefined)
                options.resetForm = false;
            if (options.taintedMessage === undefined)
                options.taintedMessage = true;
        }
        if (STORYBOOK_MODE) {
            if (options.applyAction === undefined)
                options.applyAction = false;
        }
        if (typeof options.SPA === 'string') {
            // SPA action mode is "passive", no page updates are made.
            if (options.invalidateAll === undefined)
                options.invalidateAll = false;
            if (options.applyAction === undefined)
                options.applyAction = false;
        }
        initialValidator = options.validators;
        options = {
            ...defaultFormOptions,
            ...options
        };
        if ((options.SPA === true || typeof options.SPA === 'object') &&
            options.validators === undefined) {
            console.warn('No validators set for superForm in SPA mode. ' +
                'Add a validation adapter to the validators option, or set it to false to disable this warning.');
        }
        if (!form) {
            throw new SuperFormError('No form data sent to superForm. ' +
                "Make sure the output from superValidate is used (usually data.form) and that it's not null or undefined. " +
                "Alternatively, an object with default values for the form can also be used, but then constraints won't be available.");
        }
        if (Context_isValidationObject(form) === false) {
            form = {
                id: options.id ?? Math.random().toString(36).slice(2, 10),
                valid: false,
                posted: false,
                errors: {},
                data: form,
                shape: shapeFromObject(form)
            };
        }
        form = form;
        // Check multiple id's
        const _initialFormId = options.id ?? form.id;
        const _currentPage = get(page) ?? (STORYBOOK_MODE ? {} : undefined);
        if (browser && options.warnings?.duplicateId !== false) {
            if (!formIds.has(_currentPage)) {
                formIds.set(_currentPage, new Set([_initialFormId]));
            }
            else {
                const currentForms = formIds.get(_currentPage);
                if (currentForms?.has(_initialFormId)) {
                    console.warn(multipleFormIdError(_initialFormId));
                }
                else {
                    currentForms?.add(_initialFormId);
                }
            }
        }
        /**
         * Need to clone the form data, in case it's used to populate multiple forms
         * and in components that are mounted and destroyed multiple times.
         * This also means that it needs to be set here, before it's cloned further below.
         */
        if (!initialForms.has(form)) {
            initialForms.set(form, form);
        }
        initialForm = initialForms.get(form);
        // Detect if a form is posted without JavaScript.
        if (!browser && _currentPage.form && typeof _currentPage.form === 'object') {
            const postedData = _currentPage.form;
            for (const postedForm of Context_findValidationForms(postedData).reverse()) {
                if (postedForm.id == _initialFormId && !initialForms.has(postedForm)) {
                    // Prevent multiple "posting" that can happen when components are recreated.
                    initialForms.set(postedData, postedData);
                    const pageDataForm = form;
                    // Add the missing fields from the page data form
                    form = postedForm;
                    form.constraints = pageDataForm.constraints;
                    form.shape = pageDataForm.shape;
                    // Reset the form if option set and form is valid.
                    if (form.valid &&
                        options.resetForm &&
                        (options.resetForm === true || options.resetForm())) {
                        form = clone(pageDataForm);
                        form.message = clone(postedForm.message);
                    }
                    break;
                }
            }
        }
        else {
            form = clone(initialForm);
        }
        ///// From here, form is properly initialized /////
        onDestroy(() => {
            Unsubscriptions_unsubscribe();
            NextChange_clear();
            for (const events of Object.values(formEvents)) {
                events.length = 0;
            }
            formIds.get(_currentPage)?.delete(_initialFormId);
            ActionForm_remove();
        });
        // Check for nested objects, throw if datatype isn't json
        if (options.dataType !== 'json') {
            const checkForNestedData = (key, value) => {
                if (!value || typeof value !== 'object')
                    return;
                if (Array.isArray(value)) {
                    if (value.length > 0)
                        checkForNestedData(key, value[0]);
                }
                else if (!(value instanceof Date) &&
                    !(value instanceof File) &&
                    (!browser || !(value instanceof FileList))) {
                    throw new SuperFormError(`Object found in form field "${key}". ` +
                        `Set the dataType option to "json" and add use:enhance to use nested data structures. ` +
                        `More information: https://superforms.rocks/concepts/nested-data`);
                }
            };
            for (const [key, value] of Object.entries(form.data)) {
                checkForNestedData(key, value);
            }
        }
    }
    ///// Roles ///////////////////////////////////////////////////////
    //#region Data
    /**
     * Container for store data, subscribed to with Unsubscriptions
     * to avoid "get" usage.
     */
    const __data = {
        formId: form.id,
        form: clone(form.data),
        constraints: form.constraints ?? {},
        posted: form.posted,
        errors: clone(form.errors),
        message: clone(form.message),
        tainted: undefined,
        valid: form.valid,
        submitting: false,
        shape: form.shape
    };
    const Data = __data;
    //#endregion
    //#region FormId
    const FormId = writable(options.id ?? form.id);
    //#endregion
    //#region Context
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const Context = {};
    function Context_findValidationForms(data) {
        const forms = Object.values(data).filter((v) => Context_isValidationObject(v) !== false);
        return forms;
    }
    /**
     * Return false if object isn't a validation object, otherwise the form id,
     * which can be an empty string, so always check with === false
     */
    function Context_isValidationObject(object) {
        if (!object || typeof object !== 'object')
            return false;
        if (!('valid' in object && 'errors' in object && typeof object.valid === 'boolean')) {
            return false;
        }
        return 'id' in object && typeof object.id === 'string' ? object.id : false;
    }
    //#endregion
    //#region Form
    // eslint-disable-next-line dci-lint/grouped-rolemethods
    const _formData = writable(form.data);
    const Form = {
        subscribe: _formData.subscribe,
        set: (value, options = {}) => {
            // Need to clone the value, so it won't refer to $page for example.
            const newData = clone(value);
            Tainted_update(newData, options.taint ?? true);
            return _formData.set(newData);
        },
        update: (updater, options = {}) => {
            return _formData.update((value) => {
                // No cloning here, since it's an update
                const newData = updater(value);
                Tainted_update(newData, options.taint ?? true);
                return newData;
            });
        }
    };
    function Form_isSPA() {
        return options.SPA === true || typeof options.SPA === 'object';
    }
    async function Form_validate(opts = {}) {
        const dataToValidate = opts.formData ?? Data.form;
        let errors = {};
        let status;
        const validator = opts.adapter ?? options.validators;
        if (typeof validator == 'object') {
            // Checking for full validation with the jsonSchema field (doesn't exist in client validators).
            if (validator != initialValidator && !('jsonSchema' in validator)) {
                throw new SuperFormError('Client validation adapter found in options.validators. ' +
                    'A full adapter must be used when changing validators dynamically, for example "zod" instead of "zodClient".');
            }
            status = await /* @__PURE__ */ validator.validate(dataToValidate);
            if (!status.success) {
                errors = mapErrors(status.issues, validator.shape ?? Data.shape ?? {});
            }
            else if (opts.recheckValidData !== false) {
                // need to make an additional validation, in case the data has been transformed
                return Form_validate({ ...opts, recheckValidData: false });
            }
        }
        else {
            status = { success: true, data: {} };
        }
        const data = { ...Data.form, ...dataToValidate, ...(status.success ? status.data : {}) };
        return {
            valid: status.success,
            posted: false,
            errors,
            data,
            constraints: Data.constraints,
            message: undefined,
            id: Data.formId,
            shape: Data.shape
        };
    }
    function Form__changeEvent(event) {
        if (!options.onChange || !event.paths.length || event.type == 'blur')
            return;
        let changeEvent;
        const paths = event.paths.map(mergePath);
        if (event.type &&
            event.paths.length == 1 &&
            event.formElement &&
            event.target instanceof Element) {
            changeEvent = {
                path: paths[0],
                paths,
                formElement: event.formElement,
                target: event.target,
                set(path, value, options) {
                    // Casting trick to make it think it's a SuperForm
                    fieldProxy({ form: Form }, path, options).set(value);
                },
                get(path) {
                    return get(fieldProxy(Form, path));
                }
            };
        }
        else {
            changeEvent = {
                paths,
                target: undefined,
                set(path, value, options) {
                    // Casting trick to make it think it's a SuperForm
                    fieldProxy({ form: Form }, path, options).set(value);
                },
                get(path) {
                    return get(fieldProxy(Form, path));
                }
            };
        }
        options.onChange(changeEvent);
    }
    /**
     * Make a client-side validation, updating the form data if successful.
     * @param event A change event, from html input or programmatically
     * @param force Is true if called from validateForm with update: true
     * @param adapter ValidationAdapter, if called from validateForm with schema set
     * @returns SuperValidated, or undefined if options prevented validation.
     */
    async function Form_clientValidation(event, force = false, adapter) {
        if (event) {
            if (options.validators == 'clear') {
                Errors.update(($errors) => {
                    setPaths($errors, event.paths, undefined);
                    return $errors;
                });
            }
            setTimeout(() => Form__changeEvent(event));
        }
        let skipValidation = false;
        if (!force) {
            if (options.validationMethod == 'onsubmit' || options.validationMethod == 'submit-only') {
                skipValidation = true;
            }
            else if (options.validationMethod == 'onblur' && event?.type == 'input')
                skipValidation = true;
            else if (options.validationMethod == 'oninput' && event?.type == 'blur')
                skipValidation = true;
        }
        if (skipValidation || !event || !options.validators || options.validators == 'clear') {
            if (event?.paths) {
                const formElement = event?.formElement ?? EnhancedForm;
                if (formElement)
                    Form__clearCustomValidity(formElement, event.paths);
            }
            return;
        }
        const result = await Form_validate({ adapter });
        // TODO: Add option for always setting result.data?
        if (result.valid && (event.immediate || event.type != 'input')) {
            Form.set(result.data, { taint: 'ignore' });
        }
        // Wait for tainted, so object errors can be displayed
        await tick();
        Form__displayNewErrors(result.errors, event, force);
        return result;
    }
    function Form__clearCustomValidity(formElement, paths) {
        const validity = new Map();
        if (options.customValidity && formElement) {
            for (const path of paths) {
                const name = CSS.escape(mergePath(path));
                const el = formElement.querySelector(`[name="${name}"]`);
                if (el) {
                    const message = 'validationMessage' in el ? String(el.validationMessage) : '';
                    validity.set(path.join('.'), { el, message });
                    updateCustomValidity(el, undefined);
                }
            }
        }
        return validity;
    }
    async function Form__displayNewErrors(errors, event, force) {
        const { type, immediate, multiple, paths } = event;
        const previous = Data.errors;
        const output = {};
        let validity = new Map();
        const formElement = event.formElement ?? EnhancedForm;
        if (formElement)
            validity = Form__clearCustomValidity(formElement, event.paths);
        traversePaths(errors, (error) => {
            if (!Array.isArray(error.value))
                return;
            const currentPath = [...error.path];
            if (currentPath[currentPath.length - 1] == '_errors') {
                currentPath.pop();
            }
            const joinedPath = currentPath.join('.');
            function addError() {
                //console.log('Adding error', `[${error.path.join('.')}]`, error.value); //debug
                setPaths(output, [error.path], error.value);
                if (options.customValidity && isEventError && validity.has(joinedPath)) {
                    const { el, message } = validity.get(joinedPath);
                    if (message != error.value) {
                        updateCustomValidity(el, error.value);
                        // Only need one error to display
                        validity.clear();
                    }
                }
            }
            if (force)
                return addError();
            const lastPath = error.path[error.path.length - 1];
            const isObjectError = lastPath == '_errors';
            const isEventError = error.value &&
                paths.some((path) => {
                    // If array/object, any part of the path can match. If not, exact match is required
                    return isObjectError
                        ? currentPath && path && currentPath.length > 0 && currentPath[0] == path[0]
                        : joinedPath == path.join('.');
                });
            if (isEventError && options.validationMethod == 'oninput')
                return addError();
            // Immediate, non-multiple input should display the errors
            if (immediate && !multiple && isEventError)
                return addError();
            // Special case for multiple, which should display errors on blur
            // or if any error has existed previously. Tricky UX.
            if (multiple) {
                // For multi-select, if any error has existed, display all errors
                const errorPath = pathExists(get(Errors), error.path.slice(0, -1));
                if (errorPath?.value && typeof errorPath?.value == 'object') {
                    for (const errors of Object.values(errorPath.value)) {
                        if (Array.isArray(errors)) {
                            return addError();
                        }
                    }
                }
            }
            // If previous error exist, always display
            const previousError = pathExists(previous, error.path);
            if (previousError && previousError.key in previousError.parent) {
                return addError();
            }
            if (isObjectError) {
                // New object errors should be displayed on blur events,
                // or the (parent) path is or has been tainted.
                if (options.validationMethod == 'oninput' ||
                    (type == 'blur' &&
                        Tainted_hasBeenTainted(mergePath(error.path.slice(0, -1))))) {
                    return addError();
                }
            }
            else {
                // Display text errors on blur, if the event matches the error path
                // Also, display errors if the error is in an array an it has been tainted.
                if (type == 'blur' &&
                    isEventError
                //|| (isErrorInArray &&	Tainted_hasBeenTainted(mergePath(error.path.slice(0, -1)) as FormPath<T>))
                ) {
                    return addError();
                }
            }
        });
        Errors.set(output);
    }
    function Form_set(data, options = {}) {
        // Check if file fields should be kept, usually when the server returns them as undefined.
        // in that case remove the undefined field from the new data.
        if (options.keepFiles) {
            traversePaths(Data.form, (info) => {
                if ((!browser || !(info.parent instanceof FileList)) &&
                    (info.value instanceof File || (browser && info.value instanceof FileList))) {
                    const dataPath = pathExists(data, info.path);
                    if (!dataPath || !(dataPath.key in dataPath.parent)) {
                        setPaths(data, [info.path], info.value);
                    }
                }
            });
        }
        return Form.set(data, options);
    }
    function Form_shouldReset(validForm, successActionResult) {
        return (validForm &&
            successActionResult &&
            options.resetForm &&
            (options.resetForm === true || options.resetForm()));
    }
    async function Form_updateFromValidation(form, successResult) {
        if (form.valid && successResult && Form_shouldReset(form.valid, successResult)) {
            Form_reset({ message: form.message, posted: true });
        }
        else {
            rebind({
                form,
                untaint: successResult,
                keepFiles: true,
                // Check if the form data should be used for updating, or if the invalidateAll load function should be used:
                skipFormData: options.invalidateAll == 'force'
            });
        }
        // onUpdated may check stores, so need to wait for them to update.
        if (formEvents.onUpdated.length) {
            await tick();
        }
        // But do not await on onUpdated itself, since we're already finished with the request
        for (const event of formEvents.onUpdated) {
            event({ form });
        }
    }
    function Form_reset(opts = {}) {
        if (opts.newState)
            initialForm.data = { ...initialForm.data, ...opts.newState };
        const resetData = clone(initialForm);
        resetData.data = { ...resetData.data, ...opts.data };
        if (opts.id !== undefined)
            resetData.id = opts.id;
        rebind({
            form: resetData,
            untaint: true,
            message: opts.message,
            keepFiles: false,
            posted: opts.posted
        });
    }
    async function Form_updateFromActionResult(result) {
        if (result.type == 'error') {
            throw new SuperFormError(`ActionResult of type "${result.type}" cannot be passed to update function.`);
        }
        if (result.type == 'redirect') {
            // All we need to do if redirected is to reset the form.
            // No events should be triggered because technically we're somewhere else.
            if (Form_shouldReset(true, true))
                Form_reset({ posted: true });
            return;
        }
        if (typeof result.data !== 'object') {
            throw new SuperFormError('Non-object validation data returned from ActionResult.');
        }
        const forms = Context_findValidationForms(result.data);
        if (!forms.length) {
            throw new SuperFormError('No form data returned from ActionResult. Make sure you return { form } in the form actions.');
        }
        for (const newForm of forms) {
            if (newForm.id !== Data.formId)
                continue;
            await Form_updateFromValidation(newForm, result.status >= 200 && result.status < 300);
        }
    }
    //#endregion
    const Message = writable(__data.message);
    const Constraints = writable(__data.constraints);
    const Posted = writable(__data.posted);
    const Shape = writable(__data.shape);
    //#region Errors
    const _errors = writable(form.errors);
    // eslint-disable-next-line dci-lint/grouped-rolemethods
    const Errors = {
        subscribe: _errors.subscribe,
        set(value, options) {
            return _errors.set(updateErrors(value, Data.errors, options?.force));
        },
        update(updater, options) {
            return _errors.update((value) => {
                return updateErrors(updater(value), Data.errors, options?.force);
            });
        },
        /**
         * To work with client-side validation, errors cannot be deleted but must
         * be set to undefined, to know where they existed before (tainted+error check in oninput)
         */
        clear: () => Errors.set({})
    };
    //#endregion
    //#region NextChange /////
    let NextChange = null;
    function NextChange_setHtmlEvent(event) {
        // For File inputs, if only paths are available, use that instead of replacing
        // (fileProxy updates causes this)
        if (NextChange &&
            event &&
            Object.keys(event).length == 1 &&
            event.paths?.length &&
            NextChange.target &&
            NextChange.target instanceof HTMLInputElement &&
            NextChange.target.type.toLowerCase() == 'file') {
            NextChange.paths = event.paths;
        }
        else {
            NextChange = event;
        }
        // Wait for on:input to provide additional information
        setTimeout(() => {
            Form_clientValidation(NextChange);
        }, 0);
    }
    function NextChange_additionalEventInformation(event, immediate, multiple, formElement, target) {
        if (NextChange === null) {
            NextChange = { paths: [] };
        }
        NextChange.type = event;
        NextChange.immediate = immediate;
        NextChange.multiple = multiple;
        NextChange.formElement = formElement;
        NextChange.target = target;
    }
    function NextChange_paths() {
        return NextChange?.paths ?? [];
    }
    function NextChange_clear() {
        NextChange = null;
    }
    //#endregion
    //#region Tainted
    const Tainted = {
        state: writable(),
        message: options.taintedMessage,
        clean: clone(form.data) // Important to clone form.data, so it's not comparing the same object,
    };
    function Tainted_enable() {
        options.taintedMessage = Tainted.message;
    }
    function Tainted_currentState() {
        return Tainted.state;
    }
    function Tainted_hasBeenTainted(path) {
        if (!Data.tainted)
            return false;
        if (!path)
            return !!Data.tainted;
        const field = pathExists(Data.tainted, splitPath(path));
        return !!field && field.key in field.parent;
    }
    function Tainted_isTainted(path) {
        if (typeof path === 'boolean')
            return path;
        if (typeof path === 'object')
            return Tainted__isObjectTainted(path);
        if (!Data.tainted)
            return false;
        if (!path)
            return Tainted__isObjectTainted(Data.tainted);
        const field = pathExists(Data.tainted, splitPath(path));
        return Tainted__isObjectTainted(field?.value);
    }
    function Tainted__isObjectTainted(obj) {
        if (!obj)
            return false;
        if (typeof obj === 'object') {
            for (const obj2 of Object.values(obj)) {
                if (Tainted__isObjectTainted(obj2))
                    return true;
            }
        }
        return obj === true;
    }
    /**
     * Updates the tainted state. Use most of the time, except when submitting.
     */
    function Tainted_update(newData, taintOptions) {
        // Ignore is set when returning errors from the server
        // so status messages and form-level errors won't be
        // immediately cleared by client-side validation.
        if (taintOptions == 'ignore')
            return;
        const paths = comparePaths(newData, Data.form);
        const newTainted = comparePaths(newData, Tainted.clean).map((path) => path.join());
        if (paths.length) {
            if (taintOptions == 'untaint-all' || taintOptions == 'untaint-form') {
                Tainted.state.set(undefined);
            }
            else {
                Tainted.state.update((currentlyTainted) => {
                    if (!currentlyTainted)
                        currentlyTainted = {};
                    setPaths(currentlyTainted, paths, (path, data) => {
                        // If value goes back to the clean value, untaint the path
                        if (!newTainted.includes(path.join()))
                            return undefined;
                        const currentValue = traversePath(newData, path);
                        const cleanPath = traversePath(Tainted.clean, path);
                        return currentValue && cleanPath && currentValue.value === cleanPath.value
                            ? undefined
                            : taintOptions === true
                                ? true
                                : taintOptions === 'untaint'
                                    ? undefined
                                    : data.value;
                    });
                    return currentlyTainted;
                });
            }
        }
        NextChange_setHtmlEvent({ paths });
    }
    /**
     * Overwrites the current tainted state and setting a new clean state for the form data.
     * @param tainted
     * @param newClean
     */
    function Tainted_set(tainted, newClean) {
        // TODO: Is it better to set tainted values to undefined instead of just overwriting?
        Tainted.state.set(tainted);
        if (newClean)
            Tainted.clean = newClean;
    }
    //#endregion
    //#region Timers
    const Submitting = writable(false);
    const Delayed = writable(false);
    // eslint-disable-next-line dci-lint/grouped-rolemethods
    const Timeout = writable(false);
    //#endregion
    //#region Unsubscriptions
    /**
     * Subscribe to certain stores and store the current value in Data, to avoid using get.
     * Need to clone the form data, so it won't refer to the same object and prevent change detection
     */
    const Unsubscriptions = [
        // eslint-disable-next-line dci-lint/private-role-access
        Tainted.state.subscribe((tainted) => (__data.tainted = clone(tainted))),
        // eslint-disable-next-line dci-lint/private-role-access
        Form.subscribe((form) => (__data.form = clone(form))),
        // eslint-disable-next-line dci-lint/private-role-access
        Errors.subscribe((errors) => (__data.errors = clone(errors))),
        FormId.subscribe((id) => (__data.formId = id)),
        Constraints.subscribe((constraints) => (__data.constraints = constraints)),
        Posted.subscribe((posted) => (__data.posted = posted)),
        Message.subscribe((message) => (__data.message = message)),
        Submitting.subscribe((submitting) => (__data.submitting = submitting)),
        Shape.subscribe((shape) => (__data.shape = shape))
    ];
    function Unsubscriptions_add(func) {
        Unsubscriptions.push(func);
    }
    function Unsubscriptions_unsubscribe() {
        Unsubscriptions.forEach((unsub) => unsub());
    }
    //#endregion
    //#region ActionForm
    // SPA action mode
    let ActionForm = undefined;
    function ActionForm_create(action) {
        ActionForm = document.createElement('form');
        ActionForm.method = 'POST';
        ActionForm.action = action;
        superFormEnhance(ActionForm);
        document.body.appendChild(ActionForm);
    }
    function ActionForm_setAction(action) {
        if (ActionForm)
            ActionForm.action = action;
    }
    function ActionForm_remove() {
        if (ActionForm?.parentElement) {
            ActionForm.remove();
            ActionForm = undefined;
        }
    }
    //#endregion
    const AllErrors = derived(Errors, ($errors) => ($errors ? flattenErrors($errors) : []));
    // Used for options.customValidity to display errors, even if programmatically set
    let EnhancedForm;
    ///// End of Roles //////////////////////////////////////////////////////////
    // Need to clear this and set it again when use:enhance has run, to avoid showing the
    // tainted dialog when a form doesn't use it or the browser doesn't use JS.
    options.taintedMessage = undefined;
    // Role rebinding
    function rebind(opts) {
        //console.log('🚀 ~ file: superForm.ts:721 ~ rebind ~ form:', form.data); //debug
        const form = opts.form;
        const message = opts.message ?? form.message;
        if (opts.untaint) {
            Tainted_set(typeof opts.untaint === 'boolean' ? undefined : opts.untaint, form.data);
        }
        // Form data is not tainted when rebinding.
        // Prevents object errors from being revalidated after rebind.
        // Check if form was invalidated (usually with options.invalidateAll) to prevent data from being
        // overwritten by the load function data
        if (opts.skipFormData !== true) {
            Form_set(form.data, {
                taint: 'ignore',
                keepFiles: opts.keepFiles
            });
        }
        Message.set(message);
        Errors.set(form.errors);
        FormId.set(form.id);
        Posted.set(opts.posted ?? form.posted);
        // Constraints and shape will only be set when they exist.
        if (form.constraints)
            Constraints.set(form.constraints);
        if (form.shape)
            Shape.set(form.shape);
        // Only allowed non-subscribe __data access, here in rebind
        __data.valid = form.valid;
        if (options.flashMessage && shouldSyncFlash(options)) {
            const flash = options.flashMessage.module.getFlash(page);
            if (message && get(flash) === undefined) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                flash.set(message);
            }
        }
    }
    const formEvents = {
        onSubmit: options.onSubmit ? [options.onSubmit] : [],
        onResult: options.onResult ? [options.onResult] : [],
        onUpdate: options.onUpdate ? [options.onUpdate] : [],
        onUpdated: options.onUpdated ? [options.onUpdated] : [],
        onError: options.onError ? [options.onError] : []
    };
    ///// Store subscriptions ///////////////////////////////////////////////////
    if (browser) {
        // Tainted check
        const defaultMessage = 'Leave page? Changes that you made may not be saved.';
        let forceRedirection = false;
        beforeNavigate(async (nav) => {
            if (options.taintedMessage && !Data.submitting && !forceRedirection) {
                if (Tainted_isTainted()) {
                    const { taintedMessage } = options;
                    const isTaintedFunction = typeof taintedMessage === 'function';
                    // As beforeNavigate does not support Promise, we cancel the redirection until the promise resolve
                    // if it's a custom function
                    if (isTaintedFunction)
                        nav.cancel();
                    // Does not display any dialog on page refresh or closing tab, will use default browser behaviour
                    if (nav.type === 'leave')
                        return;
                    const message = isTaintedFunction || taintedMessage === true ? defaultMessage : taintedMessage;
                    let shouldRedirect;
                    try {
                        // - rejected => shouldRedirect = false
                        // - resolved with false => shouldRedirect = false
                        // - resolved with true => shouldRedirect = true
                        shouldRedirect = isTaintedFunction ? await taintedMessage() : window.confirm(message);
                    }
                    catch {
                        shouldRedirect = false;
                    }
                    if (shouldRedirect && nav.to) {
                        try {
                            forceRedirection = true;
                            await goto(nav.to.url, { ...nav.to.params });
                            return;
                        }
                        finally {
                            // Reset forceRedirection for multiple-tainted purpose
                            forceRedirection = false;
                        }
                    }
                    else if (!shouldRedirect && !isTaintedFunction) {
                        nav.cancel();
                    }
                }
            }
        });
        // Need to subscribe to catch page invalidation.
        Unsubscriptions_add(page.subscribe(async (pageUpdate) => {
            if (STORYBOOK_MODE && pageUpdate === undefined) {
                pageUpdate = { status: 200 };
            }
            const successResult = pageUpdate.status >= 200 && pageUpdate.status < 300;
            if (options.applyAction && pageUpdate.form && typeof pageUpdate.form === 'object') {
                const actionData = pageUpdate.form;
                // Check if it is an error result, sent here from formEnhance
                if (actionData.type == 'error')
                    return;
                for (const newForm of Context_findValidationForms(actionData)) {
                    const isInitial = initialForms.has(newForm);
                    if (newForm.id !== Data.formId || isInitial) {
                        continue;
                    }
                    // Prevent multiple "posting" that can happen when components are recreated.
                    initialForms.set(newForm, newForm);
                    await Form_updateFromValidation(newForm, successResult);
                }
            }
            else if (pageUpdate.data && typeof pageUpdate.data === 'object') {
                // It's a page reload, redirect or error/failure,
                // so don't trigger any events, just update the data.
                for (const newForm of Context_findValidationForms(pageUpdate.data)) {
                    const isInitial = initialForms.has(newForm);
                    if (newForm.id !== Data.formId || isInitial) {
                        continue;
                    }
                    if (options.invalidateAll === 'force') {
                        initialForm.data = newForm.data;
                    }
                    rebind({
                        form: newForm,
                        untaint: successResult,
                        keepFiles: !Form_shouldReset(true, true)
                    });
                }
            }
        }));
        if (typeof options.SPA === 'string') {
            ActionForm_create(options.SPA);
        }
    }
    /**
     * Custom use:enhance that enables all the client-side functionality.
     * @param FormElement
     * @param events
     * @DCI-context
     */
    function superFormEnhance(FormElement, events) {
        ActionForm_remove();
        EnhancedForm = FormElement;
        if (events) {
            if (events.onError) {
                if (options.onError === 'apply') {
                    throw new SuperFormError('options.onError is set to "apply", cannot add any onError events.');
                }
                else if (events.onError === 'apply') {
                    throw new SuperFormError('Cannot add "apply" as onError event in use:enhance.');
                }
                formEvents.onError.push(events.onError);
            }
            if (events.onResult)
                formEvents.onResult.push(events.onResult);
            if (events.onSubmit)
                formEvents.onSubmit.push(events.onSubmit);
            if (events.onUpdate)
                formEvents.onUpdate.push(events.onUpdate);
            if (events.onUpdated)
                formEvents.onUpdated.push(events.onUpdated);
        }
        // Now we know that we are enhanced,
        // so we can enable the tainted form option.
        Tainted_enable();
        let lastInputChange;
        // TODO: Debounce option?
        async function onInput(e) {
            const info = inputInfo(e.target);
            // Need to wait for immediate updates due to some timing issue
            if (info.immediate && !info.file)
                await new Promise((r) => setTimeout(r, 0));
            lastInputChange = NextChange_paths();
            NextChange_additionalEventInformation('input', info.immediate, info.multiple, FormElement, e.target ?? undefined);
        }
        async function onBlur(e) {
            // Avoid triggering client-side validation while submitting
            if (Data.submitting)
                return;
            if (!lastInputChange || NextChange_paths() != lastInputChange) {
                return;
            }
            const info = inputInfo(e.target);
            // Need to wait for immediate updates due to some timing issue
            if (info.immediate && !info.file)
                await new Promise((r) => setTimeout(r, 0));
            Form_clientValidation({
                paths: lastInputChange,
                immediate: info.multiple,
                multiple: info.multiple,
                type: 'blur',
                formElement: FormElement,
                target: e.target ?? undefined
            });
            // Clear input change event, now that the field doesn't have focus anymore.
            lastInputChange = undefined;
        }
        FormElement.addEventListener('focusout', onBlur);
        FormElement.addEventListener('input', onInput);
        onDestroy(() => {
            FormElement.removeEventListener('focusout', onBlur);
            FormElement.removeEventListener('input', onInput);
            EnhancedForm = undefined;
        });
        ///// SvelteKit enhance function //////////////////////////////////
        const htmlForm = HtmlForm(FormElement, { submitting: Submitting, delayed: Delayed, timeout: Timeout }, options);
        let currentRequest;
        return kitEnhance(FormElement, async (submitParams) => {
            let jsonData = undefined;
            let validationAdapter = options.validators;
            const submit = {
                ...submitParams,
                jsonData(data) {
                    if (options.dataType !== 'json') {
                        throw new SuperFormError("options.dataType must be set to 'json' to use jsonData.");
                    }
                    jsonData = data;
                },
                validators(adapter) {
                    validationAdapter = adapter;
                }
            };
            const _submitCancel = submit.cancel;
            let cancelled = false;
            function clientValidationResult(validation) {
                const validationResult = { ...validation, posted: true };
                const status = validationResult.valid
                    ? 200
                    : (typeof options.SPA === 'boolean' || typeof options.SPA === 'string'
                        ? undefined
                        : options.SPA?.failStatus) ?? 400;
                const data = { form: validationResult };
                const result = validationResult.valid
                    ? { type: 'success', status, data }
                    : { type: 'failure', status, data };
                setTimeout(() => validationResponse({ result }), 0);
            }
            function clearOnSubmit() {
                switch (options.clearOnSubmit) {
                    case 'errors-and-message':
                        Errors.clear();
                        Message.set(undefined);
                        break;
                    case 'errors':
                        Errors.clear();
                        break;
                    case 'message':
                        Message.set(undefined);
                        break;
                }
            }
            function cancel(opts = {
                resetTimers: true
            }) {
                cancelled = true;
                if (opts.resetTimers && htmlForm.isSubmitting()) {
                    htmlForm.completed({ cancelled });
                }
                return _submitCancel();
            }
            submit.cancel = cancel;
            if (htmlForm.isSubmitting() && options.multipleSubmits == 'prevent') {
                cancel({ resetTimers: false });
            }
            else {
                if (htmlForm.isSubmitting() && options.multipleSubmits == 'abort') {
                    if (currentRequest)
                        currentRequest.abort();
                }
                htmlForm.submitting();
                currentRequest = submit.controller;
                for (const event of formEvents.onSubmit) {
                    await event(submit);
                }
            }
            if (cancelled && options.flashMessage)
                cancelFlash(options);
            if (!cancelled) {
                // Client validation
                const noValidate = !Form_isSPA() &&
                    (FormElement.noValidate ||
                        ((submit.submitter instanceof HTMLButtonElement ||
                            submit.submitter instanceof HTMLInputElement) &&
                            submit.submitter.formNoValidate));
                let validation = undefined;
                const validateForm = async () => {
                    return await Form_validate({ adapter: validationAdapter });
                };
                clearOnSubmit();
                if (!noValidate) {
                    validation = await validateForm();
                    if (!validation.valid) {
                        cancel({ resetTimers: false });
                        clientValidationResult(validation);
                    }
                }
                if (!cancelled) {
                    if (options.flashMessage &&
                        (options.clearOnSubmit == 'errors-and-message' || options.clearOnSubmit == 'message') &&
                        shouldSyncFlash(options)) {
                        options.flashMessage.module.getFlash(page).set(undefined);
                    }
                    // Deprecation fix
                    const submitData = 'formData' in submit ? submit.formData : submit.data;
                    // Prevent input/blur events to trigger client-side validation,
                    // and accidentally removing errors set by setError
                    lastInputChange = undefined;
                    if (Form_isSPA()) {
                        if (!validation)
                            validation = await validateForm();
                        cancel({ resetTimers: false });
                        clientValidationResult(validation);
                    }
                    else if (options.dataType === 'json') {
                        if (!validation)
                            validation = await validateForm();
                        const postData = clone(jsonData ?? validation.data);
                        // Move files to form data, since they cannot be serialized.
                        // Will be reassembled in superValidate.
                        traversePaths(postData, (data) => {
                            if (data.value instanceof File) {
                                const key = '__superform_file_' + mergePath(data.path);
                                submitData.append(key, data.value);
                                return data.set(undefined);
                            }
                            else if (Array.isArray(data.value) &&
                                data.value.length &&
                                data.value.every((v) => v instanceof File)) {
                                const key = '__superform_files_' + mergePath(data.path);
                                for (const file of data.value) {
                                    submitData.append(key, file);
                                }
                                return data.set(undefined);
                            }
                        });
                        // Clear post data to reduce transfer size,
                        // since $form should be serialized and sent as json.
                        Object.keys(postData).forEach((key) => {
                            // Files should be kept though, even if same key.
                            if (typeof submitData.get(key) === 'string') {
                                submitData.delete(key);
                            }
                        });
                        // Split the form data into chunks, in case it gets too large for proxy servers
                        const chunks = chunkSubstr(stringify(postData), options.jsonChunkSize ?? 500000);
                        for (const chunk of chunks) {
                            submitData.append('__superform_json', chunk);
                        }
                    }
                    if (!submitData.has('__superform_id')) {
                        // Add formId
                        const id = Data.formId;
                        if (id !== undefined)
                            submitData.set('__superform_id', id);
                    }
                    if (typeof options.SPA === 'string') {
                        ActionForm_setAction(options.SPA);
                    }
                }
            }
            ///// End of submit interaction ///////////////////////////////////////
            // Thanks to https://stackoverflow.com/a/29202760/70894
            function chunkSubstr(str, size) {
                const numChunks = Math.ceil(str.length / size);
                const chunks = new Array(numChunks);
                for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
                    chunks[i] = str.substring(o, o + size);
                }
                return chunks;
            }
            // event can be a record if an external request was returning JSON,
            // or if it failed parsing the expected JSON.
            async function validationResponse(event) {
                let cancelled = false;
                currentRequest = null;
                // Check if an error was thrown in hooks, in which case it has no type.
                let result = 'type' in event.result && 'status' in event.result
                    ? event.result
                    : {
                        type: 'error',
                        status: parseInt(String(event.result.status)) || 500,
                        error: event.result.error instanceof Error ? event.result.error : event.result
                    };
                const cancel = () => (cancelled = true);
                const data = {
                    result,
                    formEl: FormElement,
                    formElement: FormElement,
                    cancel
                };
                const unsubCheckforNav = STORYBOOK_MODE || !Form_isSPA()
                    ? () => { }
                    : navigating.subscribe(($nav) => {
                        // Check for goto to a different route in the events
                        if (!$nav || $nav.from?.route.id === $nav.to?.route.id)
                            return;
                        cancel();
                    });
                for (const event of formEvents.onResult) {
                    await event(data);
                }
                // In case it was modified in the event
                result = data.result;
                if (!cancelled) {
                    if ((result.type === 'success' || result.type == 'failure') && result.data) {
                        const forms = Context_findValidationForms(result.data);
                        if (!forms.length) {
                            throw new SuperFormError('No form data returned from ActionResult. Make sure you return { form } in the form actions.');
                        }
                        for (const newForm of forms) {
                            if (newForm.id !== Data.formId)
                                continue;
                            const data = {
                                form: newForm,
                                formEl: FormElement,
                                formElement: FormElement,
                                cancel: () => (cancelled = true)
                            };
                            for (const event of formEvents.onUpdate) {
                                await event(data);
                            }
                            if (!cancelled) {
                                if (options.customValidity) {
                                    setCustomValidityForm(FormElement, data.form.errors);
                                }
                                // Special reset case for file inputs
                                if (Form_shouldReset(data.form.valid, result.type == 'success')) {
                                    data.formElement
                                        .querySelectorAll('input[type="file"]')
                                        .forEach((e) => (e.value = ''));
                                }
                            }
                        }
                    }
                    if (!cancelled) {
                        if (result.type !== 'error') {
                            if (result.type === 'success' && options.invalidateAll) {
                                await invalidateAll();
                            }
                            if (options.applyAction) {
                                // This will trigger the page subscription in superForm,
                                // which will in turn call Data_update.
                                await applyAction(result);
                            }
                            else {
                                // Call Data_update directly to trigger events
                                await Form_updateFromActionResult(result);
                            }
                        }
                        else {
                            // Error result
                            if (options.applyAction) {
                                if (options.onError == 'apply') {
                                    await applyAction(result);
                                }
                                else {
                                    // Transform to failure, to avoid data loss
                                    // Set the data to the error result, so it will be
                                    // picked up in page.subscribe in superForm.
                                    const failResult = {
                                        type: 'failure',
                                        status: Math.floor(result.status || 500),
                                        data: result
                                    };
                                    await applyAction(failResult);
                                }
                            }
                            // Check if the error message should be replaced
                            if (options.onError !== 'apply') {
                                const data = { result, message: Message };
                                for (const onErrorEvent of formEvents.onError) {
                                    if (onErrorEvent !== 'apply' &&
                                        (onErrorEvent != defaultOnError || !options.flashMessage?.onError)) {
                                        await onErrorEvent(data);
                                    }
                                }
                            }
                        }
                        // Trigger flash message event if there was an error
                        if (options.flashMessage) {
                            if (result.type == 'error' && options.flashMessage.onError) {
                                await options.flashMessage.onError({
                                    result,
                                    flashMessage: options.flashMessage.module.getFlash(page)
                                });
                            }
                        }
                    }
                }
                if (cancelled && options.flashMessage) {
                    cancelFlash(options);
                }
                // Redirect messages are handled in onDestroy and afterNavigate in client/form.ts.
                if (cancelled || result.type != 'redirect') {
                    htmlForm.completed({ cancelled });
                }
                else if (STORYBOOK_MODE) {
                    htmlForm.completed({ cancelled, clearAll: true });
                }
                else {
                    const unsub = navigating.subscribe(($nav) => {
                        if ($nav)
                            return;
                        // Timeout required when applyAction is false
                        setTimeout(() => {
                            try {
                                if (unsub)
                                    unsub();
                            }
                            catch {
                                // If component is already destroyed?
                            }
                        });
                        if (htmlForm.isSubmitting()) {
                            htmlForm.completed({ cancelled, clearAll: true });
                        }
                    });
                }
                unsubCheckforNav();
            }
            return validationResponse;
        });
    }
    ///// Return the SuperForm object /////////////////////////////////
    return {
        form: Form,
        formId: FormId,
        errors: Errors,
        message: Message,
        constraints: Constraints,
        tainted: Tainted_currentState(),
        submitting: readonly(Submitting),
        delayed: readonly(Delayed),
        timeout: readonly(Timeout),
        options: options,
        capture() {
            return {
                valid: Data.valid,
                posted: Data.posted,
                errors: Data.errors,
                data: Data.form,
                constraints: Data.constraints,
                message: Data.message,
                id: Data.formId,
                tainted: Data.tainted,
                shape: Data.shape
            };
        },
        restore: ((snapshot) => {
            rebind({ form: snapshot, untaint: snapshot.tainted ?? true });
        }),
        async validate(path, opts = {}) {
            if (!options.validators) {
                throw new SuperFormError('options.validators must be set to use the validate method.');
            }
            if (opts.update === undefined)
                opts.update = true;
            if (opts.taint === undefined)
                opts.taint = false;
            if (typeof opts.errors == 'string')
                opts.errors = [opts.errors];
            let data;
            const splittedPath = splitPath(path);
            if ('value' in opts) {
                if (opts.update === true || opts.update === 'value') {
                    // eslint-disable-next-line dci-lint/private-role-access
                    Form.update(($form) => {
                        setPaths($form, [splittedPath], opts.value);
                        return $form;
                    }, { taint: opts.taint });
                    data = Data.form;
                }
                else {
                    data = clone(Data.form);
                    setPaths(data, [splittedPath], opts.value);
                }
            }
            else {
                data = Data.form;
            }
            const result = await Form_validate({ formData: data });
            const error = pathExists(result.errors, splittedPath);
            // Replace with custom error, if it exist
            if (error && error.value && opts.errors) {
                error.value = opts.errors;
            }
            if (opts.update === true || opts.update == 'errors') {
                Errors.update(($errors) => {
                    setPaths($errors, [splittedPath], error?.value);
                    return $errors;
                });
            }
            return error?.value;
        },
        async validateForm(opts = {}) {
            if (!options.validators && !opts.schema) {
                throw new SuperFormError('options.validators or the schema option must be set to use the validateForm method.');
            }
            const result = opts.update
                ? await Form_clientValidation({ paths: [] }, true, opts.schema)
                : Form_validate({ adapter: opts.schema });
            if (opts.update && EnhancedForm) {
                // Focus on first error field
                setTimeout(() => {
                    if (EnhancedForm)
                        scrollToFirstError(EnhancedForm, {
                            ...options,
                            scrollToError: opts.focusOnError === false ? 'off' : options.scrollToError
                        });
                }, 1);
            }
            return result || Form_validate({ adapter: opts.schema });
        },
        allErrors: AllErrors,
        posted: Posted,
        reset(options) {
            return Form_reset({
                message: options?.keepMessage ? Data.message : undefined,
                data: options?.data,
                id: options?.id,
                newState: options?.newState
            });
        },
        submit(submitter) {
            const form = EnhancedForm
                ? EnhancedForm
                : submitter && submitter instanceof HTMLElement
                    ? submitter.closest('form')
                    : undefined;
            if (!form) {
                throw new SuperFormError('use:enhance must be added to the form to use submit, or pass a HTMLElement inside the form (or the form itself) as an argument.');
            }
            const isSubmitButton = submitter &&
                ((submitter instanceof HTMLButtonElement && submitter.type == 'submit') ||
                    (submitter instanceof HTMLInputElement && ['submit', 'image'].includes(submitter.type)));
            form.requestSubmit(isSubmitButton ? submitter : undefined);
        },
        isTainted: Tainted_isTainted,
        enhance: superFormEnhance
    };
}
