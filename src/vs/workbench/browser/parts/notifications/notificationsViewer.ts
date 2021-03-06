/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IDelegate, IRenderer } from 'vs/base/browser/ui/list/list';
import { renderMarkdown, IContentActionHandler } from 'vs/base/browser/htmlContentRenderer';
import { clearNode, addClass, removeClass, toggleClass } from 'vs/base/browser/dom';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import URI from 'vs/base/common/uri';
import { onUnexpectedError } from 'vs/base/common/errors';
import { localize } from 'vs/nls';
import { Button } from 'vs/base/browser/ui/button/button';
import { attachButtonStyler, attachProgressBarStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { IAction, IActionRunner } from 'vs/base/common/actions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { DropdownMenuActionItem } from 'vs/base/browser/ui/dropdown/dropdown';
import { INotificationViewItem, NotificationViewItem, NotificationViewItemLabelKind } from 'vs/workbench/common/notifications';
import { ClearNotificationAction, ExpandNotificationAction, CollapseNotificationAction, ConfigureNotificationAction } from 'vs/workbench/browser/parts/notifications/notificationsActions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { MarkedOptions } from 'vs/base/common/marked/marked';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { Severity } from 'vs/platform/notification/common/notification';

export class NotificationsListDelegate implements IDelegate<INotificationViewItem> {

	private static readonly ROW_HEIGHT = 42;
	private static readonly LINE_HEIGHT = 22;

	private offsetHelper: HTMLElement;

	constructor(container: HTMLElement) {
		this.offsetHelper = this.createOffsetHelper(container);
	}

	private createOffsetHelper(container: HTMLElement): HTMLElement {
		const offsetHelper = document.createElement('div');
		offsetHelper.style.opacity = '0';
		offsetHelper.style.position = 'absolute'; // do not mess with the visual layout
		offsetHelper.style.width = '100%'; // ensure to fill contauner to measure true width
		offsetHelper.style.overflow = 'hidden'; // do not overflow
		offsetHelper.style.whiteSpace = 'nowrap'; // do not wrap to measure true width

		container.appendChild(offsetHelper);

		return offsetHelper;
	}

	public getHeight(notification: INotificationViewItem): number {

		// First row: message and actions
		let expandedHeight = NotificationsListDelegate.ROW_HEIGHT;

		if (!notification.expanded) {
			return expandedHeight; // return early if there are no more rows to show
		}

		// Dynamic height: if message overflows
		const preferredMessageHeight = this.computePreferredRows(notification) * NotificationsListDelegate.LINE_HEIGHT;
		const messageOverflows = NotificationsListDelegate.LINE_HEIGHT < preferredMessageHeight;
		if (messageOverflows) {
			const overflow = preferredMessageHeight - NotificationsListDelegate.LINE_HEIGHT;
			expandedHeight += overflow;
		}

		// Last row: source and buttons if we have any
		if (notification.source || notification.actions.primary.length > 0) {
			expandedHeight += NotificationsListDelegate.ROW_HEIGHT;
		}

		return expandedHeight;
	}

	private computePreferredRows(notification: INotificationViewItem): number {

		// Render message markdown into offset helper
		const renderedMessage = NotificationMessageMarkdownRenderer.render(notification.message);
		this.offsetHelper.appendChild(renderedMessage);

		// Compute message width taking overflow into account
		const messageWidth = Math.max(renderedMessage.scrollWidth, renderedMessage.offsetWidth);

		// One row per exceeding the total width of the container
		const availableWidth = this.offsetHelper.offsetWidth - (20 /* paddings */ + 22 /* severity */ + (24 * 3) /* toolbar */);
		const preferredRows = Math.ceil(messageWidth / availableWidth);

		// Always clear offset helper after use
		clearNode(this.offsetHelper);

		return preferredRows;
	}

	public getTemplateId(element: INotificationViewItem): string {
		if (element instanceof NotificationViewItem) {
			return NotificationRenderer.TEMPLATE_ID;
		}

		return void 0;
	}
}

export interface INotificationTemplateData {
	container: HTMLElement;
	toDispose: IDisposable[];

	mainRow: HTMLElement;
	icon: HTMLElement;
	message: HTMLElement;
	toolbar: ActionBar;

	detailsRow: HTMLElement;
	source: HTMLElement;
	buttonsContainer: HTMLElement;
	progress: ProgressBar;

	renderer: NotificationTemplateRenderer;
}

class NotificationMessageMarkdownRenderer {

	private static readonly MARKED_NOOP = (text?: string) => text || '';
	private static readonly MARKED_NOOP_TARGETS = [
		'blockquote', 'br', 'code', 'codespan', 'del', 'em', 'heading', 'hr', 'html',
		'image', 'list', 'listitem', 'paragraph', 'strong', 'table', 'tablecell',
		'tablerow'
	];

	public static render(markdown: IMarkdownString, actionHandler?: IContentActionHandler): HTMLElement {
		return renderMarkdown(markdown, {
			inline: true,
			joinRendererConfiguration: renderer => {

				// Overwrite markdown render functions as no-ops
				NotificationMessageMarkdownRenderer.MARKED_NOOP_TARGETS.forEach(fn => renderer[fn] = NotificationMessageMarkdownRenderer.MARKED_NOOP);

				return {
					gfm: false, // disable GitHub style markdown,
					smartypants: false // disable some text transformations
				} as MarkedOptions;
			},
			actionHandler
		});
	}
}

export class NotificationRenderer implements IRenderer<INotificationViewItem, INotificationTemplateData> {

	public static readonly TEMPLATE_ID = 'notification';

	constructor(
		private actionRunner: IActionRunner,
		@IThemeService private themeService: IThemeService,
		@IContextMenuService private contextMenuService: IContextMenuService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
	}

	public get templateId() {
		return NotificationRenderer.TEMPLATE_ID;
	}

	public renderTemplate(container: HTMLElement): INotificationTemplateData {
		const data: INotificationTemplateData = Object.create(null);
		data.toDispose = [];

		// Container
		data.container = document.createElement('div');
		addClass(data.container, 'notification-list-item');

		// Main Row
		data.mainRow = document.createElement('div');
		addClass(data.mainRow, 'notification-list-item-main-row');

		// Icon
		data.icon = document.createElement('div');
		addClass(data.icon, 'notification-list-item-icon');

		// Message
		data.message = document.createElement('div');
		addClass(data.message, 'notification-list-item-message');

		// Toolbar
		const toolbarContainer = document.createElement('div');
		addClass(toolbarContainer, 'notification-list-item-toolbar-container');
		data.toolbar = new ActionBar(
			toolbarContainer,
			{
				ariaLabel: localize('notificationActions', "Notification Actions"),
				actionItemProvider: action => {
					if (action instanceof ConfigureNotificationAction) {
						const item = new DropdownMenuActionItem(action, action.configurationActions, this.contextMenuService, null, null, null, action.class);
						data.toDispose.push(item);

						return item;
					}

					return null;
				}
			}
		);
		data.toDispose.push(data.toolbar);

		// Details Row
		data.detailsRow = document.createElement('div');
		addClass(data.detailsRow, 'notification-list-item-details-row');

		// Source
		data.source = document.createElement('div');
		addClass(data.source, 'notification-list-item-source');

		// Buttons Container
		data.buttonsContainer = document.createElement('div');
		addClass(data.buttonsContainer, 'notification-list-item-buttons-container');

		container.appendChild(data.container);

		// the details row appears first in order for better keyboard access to notification buttons
		data.container.appendChild(data.detailsRow);
		data.detailsRow.appendChild(data.source);
		data.detailsRow.appendChild(data.buttonsContainer);

		// main row
		data.container.appendChild(data.mainRow);
		data.mainRow.appendChild(data.icon);
		data.mainRow.appendChild(data.message);
		data.mainRow.appendChild(toolbarContainer);

		// Progress: below the rows to span the entire width of the item
		data.progress = new ProgressBar(container);
		data.toDispose.push(attachProgressBarStyler(data.progress, this.themeService));
		data.toDispose.push(data.progress);

		// Renderer
		data.renderer = this.instantiationService.createInstance(NotificationTemplateRenderer, data, this.actionRunner);
		data.toDispose.push(data.renderer);

		return data;
	}

	public renderElement(notification: INotificationViewItem, index: number, data: INotificationTemplateData): void {
		data.renderer.setInput(notification);
	}

	public disposeTemplate(templateData: INotificationTemplateData): void {
		templateData.toDispose = dispose(templateData.toDispose);
	}
}

export class NotificationTemplateRenderer {

	private static closeNotificationAction: ClearNotificationAction;
	private static expandNotificationAction: ExpandNotificationAction;
	private static collapseNotificationAction: CollapseNotificationAction;

	private static readonly SEVERITIES: ('info' | 'warning' | 'error')[] = ['info', 'warning', 'error'];

	private inputDisposeables: IDisposable[];

	constructor(
		private template: INotificationTemplateData,
		private actionRunner: IActionRunner,
		@IOpenerService private openerService: IOpenerService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThemeService private themeService: IThemeService,
		@IKeybindingService private keybindingService: IKeybindingService
	) {
		this.inputDisposeables = [];

		if (!NotificationTemplateRenderer.closeNotificationAction) {
			NotificationTemplateRenderer.closeNotificationAction = instantiationService.createInstance(ClearNotificationAction, ClearNotificationAction.ID, ClearNotificationAction.LABEL);
			NotificationTemplateRenderer.expandNotificationAction = instantiationService.createInstance(ExpandNotificationAction, ExpandNotificationAction.ID, ExpandNotificationAction.LABEL);
			NotificationTemplateRenderer.collapseNotificationAction = instantiationService.createInstance(CollapseNotificationAction, CollapseNotificationAction.ID, CollapseNotificationAction.LABEL);
		}
	}

	public setInput(notification: INotificationViewItem): void {
		this.inputDisposeables = dispose(this.inputDisposeables);

		this.render(notification);
	}

	private render(notification: INotificationViewItem): void {

		// Container
		toggleClass(this.template.container, 'expanded', notification.expanded);

		// Severity Icon
		this.renderSeverity(notification);

		// Message
		const messageOverflows = this.renderMessage(notification);

		// Secondary Actions
		this.renderSecondaryActions(notification, messageOverflows);

		// Source
		this.renderSource(notification);

		// Buttons
		this.renderButtons(notification);

		// Progress
		this.renderProgress(notification);

		// Label Change Events
		this.inputDisposeables.push(notification.onDidLabelChange(event => {
			switch (event.kind) {
				case NotificationViewItemLabelKind.SEVERITY:
					this.renderSeverity(notification);
					break;
				case NotificationViewItemLabelKind.PROGRESS:
					this.renderProgress(notification);
					break;
			}
		}));
	}

	private renderSeverity(notification: INotificationViewItem): void {
		NotificationTemplateRenderer.SEVERITIES.forEach(severity => {
			const domAction = notification.severity === this.toSeverity(severity) ? addClass : removeClass;
			domAction(this.template.icon, `icon-${severity}`);
		});
	}

	private renderMessage(notification: INotificationViewItem): boolean {
		clearNode(this.template.message);
		this.template.message.appendChild(NotificationMessageMarkdownRenderer.render(notification.message, {
			callback: (content: string) => this.openerService.open(URI.parse(content)).then(void 0, onUnexpectedError),
			disposeables: this.inputDisposeables
		}));

		const messageOverflows = notification.canCollapse && !notification.expanded && this.template.message.scrollWidth > this.template.message.clientWidth;
		if (messageOverflows) {
			this.template.message.title = this.template.message.textContent;
		} else {
			this.template.message.removeAttribute('title');
		}

		const links = this.template.message.querySelectorAll('a');
		for (let i = 0; i < links.length; i++) {
			links.item(i).tabIndex = -1; // prevent keyboard navigation to links to allow for better keyboard support within a message
		}

		return messageOverflows;
	}

	private renderSecondaryActions(notification: INotificationViewItem, messageOverflows: boolean): void {
		const actions: IAction[] = [];

		// Secondary Actions
		if (notification.actions.secondary.length > 0) {
			const configureNotificationAction = this.instantiationService.createInstance(ConfigureNotificationAction, ConfigureNotificationAction.ID, ConfigureNotificationAction.LABEL, notification.actions.secondary);
			actions.push(configureNotificationAction);
			this.inputDisposeables.push(configureNotificationAction);
		}

		// Expand / Collapse
		let showExpandCollapseAction = false;
		if (notification.canCollapse) {
			if (notification.expanded) {
				showExpandCollapseAction = true; // allow to collapse an expanded message
			} else if (notification.source) {
				showExpandCollapseAction = true; // allow to expand to details row
			} else if (messageOverflows) {
				showExpandCollapseAction = true; // allow to expand if message overflows
			}
		}

		if (showExpandCollapseAction) {
			actions.push(notification.expanded ? NotificationTemplateRenderer.collapseNotificationAction : NotificationTemplateRenderer.expandNotificationAction);
		}

		// Close
		actions.push(NotificationTemplateRenderer.closeNotificationAction);

		this.template.toolbar.clear();
		this.template.toolbar.context = notification;
		actions.forEach(action => this.template.toolbar.push(action, { icon: true, label: false, keybinding: this.getKeybindingLabel(action) }));
	}

	private renderSource(notification): void {
		if (notification.expanded && notification.source) {
			this.template.source.innerText = localize('notificationSource', "Source: {0}", notification.source);
		} else {
			this.template.source.innerText = '';
		}
	}

	private renderButtons(notification: INotificationViewItem): void {
		clearNode(this.template.buttonsContainer);

		if (notification.expanded) {
			notification.actions.primary.forEach(action => this.createButton(notification, action));
		}
	}

	private renderProgress(notification: INotificationViewItem): void {

		// Return early if the item has no progress
		if (!notification.hasProgress()) {
			this.template.progress.stop().getContainer().hide();

			return;
		}

		// Infinite
		const state = notification.progress.state;
		if (state.infinite) {
			this.template.progress.infinite().getContainer().show();
		}

		// Total / Worked
		else if (state.total || state.worked) {
			if (state.total) {
				this.template.progress.total(state.total);
			}

			if (state.worked) {
				this.template.progress.worked(state.worked).getContainer().show();
			}
		}

		// Done
		else {
			this.template.progress.done().getContainer().hide();
		}
	}

	private toSeverity(severity: 'info' | 'warning' | 'error'): Severity {
		switch (severity) {
			case 'info':
				return Severity.Info;
			case 'warning':
				return Severity.Warning;
			case 'error':
				return Severity.Error;
		}
	}

	private getKeybindingLabel(action: IAction): string {
		const keybinding = this.keybindingService.lookupKeybinding(action.id);

		return keybinding ? keybinding.getLabel() : void 0;
	}

	private createButton(notification: INotificationViewItem, action: IAction): Button {
		const button = new Button(this.template.buttonsContainer);
		button.label = action.label;
		this.inputDisposeables.push(button.onDidClick(() => {

			// Run action
			this.actionRunner.run(action);

			// Hide notification
			notification.dispose();
		}));

		this.inputDisposeables.push(attachButtonStyler(button, this.themeService));
		this.inputDisposeables.push(button);

		return button;
	}

	public dispose(): void {
		this.inputDisposeables = dispose(this.inputDisposeables);
	}
}