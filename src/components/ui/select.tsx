import { Combobox, useComboboxContext } from "@kobalte/core/combobox";
import { Select as SelectPrimitive } from "@kobalte/core/select";
import { createMemo, Show } from "solid-js";
import "./select.css";

export type SelectOption = {
	value: string;
	label: string;
	disabled?: boolean;
};

type SelectProps = {
	id: string;
	label: string;
	value: string | undefined;
	options: SelectOption[];
	onChange: (value: string) => void;
	placeholder?: string;
	searchable?: boolean;
	disabled?: boolean;
};

function Chevron() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			aria-hidden="true"
		>
			<path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.8" />
		</svg>
	);
}

function Check() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			aria-hidden="true"
		>
			<path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="2" />
		</svg>
	);
}

function SearchResults(props: { label: string }) {
	const context = useComboboxContext();
	const count = () => context.listState().collection().getSize();
	return (
		<>
			<Combobox.Listbox class="ui-select-list" aria-label={props.label} />
			<Show when={count() > 0}>
				<output class="ui-select-result-count" aria-live="polite">
					{count()} 个可选项
				</output>
			</Show>
			<Show when={count() === 0}>
				<p class="ui-select-empty" role="status">
					没有匹配的选项，换个关键词试试
				</p>
			</Show>
		</>
	);
}

function SearchInput(props: { id: string; label: string; title?: string }) {
	const context = useComboboxContext();
	const openOptions = () => {
		if (!context.isOpen()) context.open(false, "manual");
	};
	return (
		<Combobox.Input
			id={props.id}
			aria-label={props.label}
			class="ui-select-input"
			title={props.title}
			onFocus={(event) => {
				event.currentTarget.select();
				openOptions();
			}}
			onClick={openOptions}
		/>
	);
}

// All consumers keep their string values; the primitives own focus, keyboard
// navigation, outside dismissal and viewport-aware popup positioning.
export function Select(props: SelectProps) {
	const selected = createMemo(
		() => props.options.find((option) => option.value === props.value) ?? null,
		null,
		{
			// Refreshing option objects must not erase an in-progress search.
			equals: (previous, next) =>
				previous?.value === next?.value &&
				previous?.label === next?.label &&
				previous?.disabled === next?.disabled,
		},
	);
	const choose = (option: SelectOption | null) => {
		if (option !== null) props.onChange(option.value);
	};
	return (
		<Show
			when={props.searchable}
			fallback={
				<SelectPrimitive<SelectOption>
					id={`${props.id}-select`}
					class="ui-select"
					options={props.options}
					value={selected()}
					onChange={choose}
					optionValue={(option) => `option:${option.value}`}
					optionTextValue="label"
					optionDisabled="disabled"
					placeholder={props.placeholder ?? "请选择"}
					disabled={props.disabled}
					disallowEmptySelection
					placement="bottom-start"
					gutter={6}
					sameWidth
					fitViewport
					overflowPadding={12}
					itemComponent={(itemProps) => (
						<SelectPrimitive.Item
							class="ui-select-option"
							item={itemProps.item}
						>
							<SelectPrimitive.ItemLabel>
								{itemProps.item.rawValue.label}
							</SelectPrimitive.ItemLabel>
							<span class="ui-select-check">
								<SelectPrimitive.ItemIndicator>
									<Check />
								</SelectPrimitive.ItemIndicator>
							</span>
						</SelectPrimitive.Item>
					)}
				>
					<SelectPrimitive.Trigger
						id={props.id}
						aria-label={props.label}
						class="ui-select-trigger"
					>
						<SelectPrimitive.Value<SelectOption> class="ui-select-value">
							{(state) => state.selectedOption().label}
						</SelectPrimitive.Value>
						<SelectPrimitive.Icon class="ui-select-chevron">
							<Chevron />
						</SelectPrimitive.Icon>
					</SelectPrimitive.Trigger>
					<SelectPrimitive.Portal>
						<SelectPrimitive.Content class="ui-select-content">
							<SelectPrimitive.Listbox class="ui-select-list" />
						</SelectPrimitive.Content>
					</SelectPrimitive.Portal>
				</SelectPrimitive>
			}
		>
			<Combobox<SelectOption>
				id={`${props.id}-select`}
				class="ui-select"
				options={props.options}
				value={selected()}
				onChange={choose}
				optionValue={(option) => `option:${option.value}`}
				optionTextValue="label"
				optionLabel="label"
				optionDisabled="disabled"
				placeholder={props.placeholder ?? "输入关键词搜索"}
				disabled={props.disabled}
				defaultFilter="contains"
				triggerMode="input"
				disallowEmptySelection
				allowsEmptyCollection
				translations={{
					focusAnnouncement: (text, isSelected) =>
						`${text}${isSelected ? "，已选中" : ""}`,
					// SearchResults provides the localized live result count.
					countAnnouncement: () => undefined,
					selectedAnnouncement: (text) => `已选择${text}`,
					triggerLabel: `展开${props.label}选项`,
					listboxLabel: props.label,
				}}
				placement="bottom-start"
				gutter={6}
				sameWidth
				fitViewport
				overflowPadding={12}
				itemComponent={(itemProps) => (
					<Combobox.Item class="ui-select-option" item={itemProps.item}>
						<Combobox.ItemLabel>
							{itemProps.item.rawValue.label}
						</Combobox.ItemLabel>
						<span class="ui-select-check">
							<Combobox.ItemIndicator>
								<Check />
							</Combobox.ItemIndicator>
						</span>
					</Combobox.Item>
				)}
			>
				<Combobox.Control class="ui-select-control">
					<svg
						class="ui-select-search-icon"
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						aria-hidden="true"
					>
						<circle
							cx="6.8"
							cy="6.8"
							r="4.1"
							stroke="currentColor"
							stroke-width="1.6"
						/>
						<path d="m10 10 3.5 3.5" stroke="currentColor" stroke-width="1.6" />
					</svg>
					<SearchInput
						id={props.id}
						label={props.label}
						title={selected()?.label}
					/>
					<Combobox.Trigger
						class="ui-select-toggle"
						aria-label={`展开${props.label}选项`}
					>
						<Combobox.Icon class="ui-select-chevron">
							<Chevron />
						</Combobox.Icon>
					</Combobox.Trigger>
				</Combobox.Control>
				<Combobox.Portal>
					<Combobox.Content class="ui-select-content">
						<SearchResults label={props.label} />
					</Combobox.Content>
				</Combobox.Portal>
			</Combobox>
		</Show>
	);
}
