'use strict';
'require baseclass';

/*
 * Line icons for the zapret2 pages: one 24x24 grid, round caps, the stroke takes the color of
 * the surrounding text (currentColor), so they follow the theme and the state colors.
 *
 * The markup below is a fixed set of constants written here: no text from the router or from
 * the network ever goes into it, so setting it as innerHTML is safe.
 */

var ICONS = {
	'check':        '<path d="M5 12.8l4.4 4.4L19 7.4"/>',
	'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.7 2.7 5-5.3"/>',
	'x':            '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
	'x-circle':     '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
	'alert':        '<path d="M12 3.6l9.2 16H2.8z"/><path d="M12 9.8v4.4"/><path d="M12 17.1h.01"/>',
	'info':         '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><path d="M12 7.8h.01"/>',
	'help':         '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.6a2.6 2.6 0 1 1 3.7 2.3c-.8.5-1.2 1-1.2 2"/><path d="M12 17h.01"/>',
	'shield':       '<path d="M12 3l7.5 2.8v5.7c0 4.5-3.1 8-7.5 9.5-4.4-1.5-7.5-5-7.5-9.5V5.8z"/>',
	'shield-check': '<path d="M12 3l7.5 2.8v5.7c0 4.5-3.1 8-7.5 9.5-4.4-1.5-7.5-5-7.5-9.5V5.8z"/><path d="M8.6 12l2.4 2.4 4.4-4.6"/>',
	'shield-alert': '<path d="M12 3l7.5 2.8v5.7c0 4.5-3.1 8-7.5 9.5-4.4-1.5-7.5-5-7.5-9.5V5.8z"/><path d="M12 8.6v4"/><path d="M12 15.6h.01"/>',
	'shield-off':   '<path d="M9.5 4.5L12 3l7.5 2.8v5.7c0 1.5-.3 2.9-.9 4.1"/><path d="M5.2 7.2c-.5.8-.7 2.4-.7 4.3 0 4.5 3.1 8 7.5 9.5 1.3-.4 2.5-1 3.5-1.8"/><path d="M3.5 3.5l17 17"/>',
	'power':        '<path d="M12 3v8.5"/><path d="M6.7 6.8a7.6 7.6 0 1 0 10.6 0"/>',
	'refresh':      '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.6"/><path d="M20 3.6v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.4"/><path d="M4 20.4v-5h5"/>',
	'play':         '<path d="M7.5 4.8v14.4L19 12z"/>',
	'stop':         '<rect x="6" y="6" width="12" height="12" rx="2"/>',
	'download':     '<path d="M12 4v11"/><path d="M7.4 10.8l4.6 4.6 4.6-4.6"/><path d="M5 19.5h14"/>',
	'external':     '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
	'search':       '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.5 15.5L20 20"/>',
	'eye':          '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
	'edit':         '<path d="M4.5 19.5l1-4.2L16 4.8a2.1 2.1 0 0 1 3 0l.2.2a2.1 2.1 0 0 1 0 3L8.7 18.5z"/><path d="M14 6.8l3.2 3.2"/>',
	'copy':         '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
	'trash':        '<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.4 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.6 7"/><path d="M10.2 11v5.5M13.8 11v5.5"/>',
	'plus':         '<path d="M12 5v14M5 12h14"/>',
	'list':         '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.6 6h.01M4.6 12h.01M4.6 18h.01"/>',
	'globe':        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3z"/>',
	'zap':          '<path d="M13.2 3L5.5 13.4h5.9L10.8 21l7.7-10.4h-5.9z"/>',
	'network':      '<circle cx="12" cy="5.5" r="2.3"/><circle cx="5.5" cy="18" r="2.3"/><circle cx="18.5" cy="18" r="2.3"/><path d="M11 7.6L6.6 15.9M13 7.6l4.4 8.3M7.8 18h8.4"/>',
	'sliders':      '<path d="M4 7h8.5M17 7h3M4 17h3M11.5 17H20"/><circle cx="14.7" cy="7" r="2.2"/><circle cx="9.3" cy="17" r="2.2"/>',
	'ban':          '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
	'activity':     '<path d="M3 12.5h3.8l2.4-6.8 4.3 12.6 2.6-5.8H21"/>',
	'clock':        '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
	'file':         '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 13h6M9 16.5h4"/>',
	'terminal':     '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M7.5 9.8l2.7 2.4-2.7 2.4M12.8 15h3.8"/>',
	'chevron':      '<path d="M9 6l6 6-6 6"/>'
};

/* the state colors used on all pages */
var COLORS = {
	ok:   '#2e7d32',
	warn: '#ef6c00',
	bad:  '#c62828',
	off:  '#6b7280',
	info: '#1565c0',
	lua:  '#8e24aa'
};

return baseclass.extend({
	colors: COLORS,

	/* the names of all icons (used by the test page) */
	names: function() {
		return Object.keys(ICONS);
	},

	/*
	 * An <svg> element; the color comes from the text color around it. The LuCI theme paints every svg that
	 * sits directly in a <div style="..."> with a solid background (for its charts): only an inline
	 * !important beats that rule.
	 */
	icon: function(name, size) {
		var box = document.createElement('div');
		var px = size || 18;

		box.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + px + '" height="' + px +
			'" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
			' style="flex:none;vertical-align:-0.22em;background:transparent !important" aria-hidden="true" focusable="false">' +
			(ICONS[name] || ICONS.help) + '</svg>';

		return box.firstChild;
	},

	/* a rounded tag: an icon and a text in the given color on a light background of the same color */
	chip: function(name, text, color, size) {
		var span = this.label(name, text, size || 15);

		span.style.color = color;
		span.style.background = color + '1f';
		span.style.border = '1px solid ' + color + '40';
		span.style.borderRadius = '1em';
		span.style.padding = '.05em .65em .05em .5em';
		span.style.fontSize = '90%';
		span.style.whiteSpace = 'nowrap';

		return span;
	},

	/* an icon followed by a text, for buttons and headings; the text is always a text node */
	label: function(name, text, size) {
		var span = document.createElement('span');

		span.style.display = 'inline-flex';
		span.style.alignItems = 'center';
		span.style.gap = '.45em';
		span.appendChild(this.icon(name, size));
		span.appendChild(document.createTextNode(text));

		return span;
	}
});
