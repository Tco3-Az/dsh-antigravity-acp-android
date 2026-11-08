export interface UiAuthOptions {
    authUrl?: string;
    lang?: string;
    components?: string[];
}
export interface UiQuotaOptions {
    model?: string;
    quotaPercent?: number;
    resetTime?: string;
    lang?: string;
}
export declare function unauthCardView(options?: UiAuthOptions): {
    v: 1;
    type: "stack";
    title: string;
    children: ({
        type: "callout";
        tone: "info";
        text: string;
        items?: undefined;
    } | {
        type: "actions";
        items: ({
            label: string;
            style: "primary";
            action: {
                id: string;
            };
        } | {
            label: string;
            style: "plain";
            action: {
                id: string;
            };
        })[];
        tone?: undefined;
        text?: undefined;
    })[];
} | {
    v: 2;
    type: "stack";
    title: string;
    children: ({
        type: "actions";
        items: {
            label: string;
            action: {
                id: string;
            };
        }[];
        label?: undefined;
        expanded?: undefined;
        children?: undefined;
    } | {
        type: "collapsible";
        label: string;
        expanded: boolean;
        children: {
            type: "form";
            submit: {
                id: string;
            };
            submitLabel: string;
            children: {
                type: "textField";
                label: string;
                bind: string;
                placeholder: string;
                maxLength: number;
            }[];
        }[];
        items?: undefined;
    })[];
};
export declare function connectedCardView(options?: UiQuotaOptions): {
    v: 1;
    type: "stack";
    title: string;
    children: ({
        type: "keyValue";
        items: string[][];
    } | {
        type: "actions";
        items: {
            label: string;
            action: {
                id: string;
            };
        }[];
    })[];
};
export declare function stripView(state?: {
    authorized?: boolean;
    connected?: boolean;
}, lang?: string): {
    text: string;
    icon: string;
    tone: string;
};
