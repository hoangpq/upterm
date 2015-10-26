import * as _ from 'lodash';
import * as e from '../Enums';
import * as React from 'react';
import Autocomplete from './Autocomplete';
import DecorationToggle from './DecorationToggle';
import History from '../History';
import {stopBubblingUp, scrollToBottom} from './ViewUtils';
import Invocation from "../Invocation";
import {Suggestion} from "../Interfaces";
import InvocationView from "./Invocation";
import PromptModel from "../Prompt";
const Rx = require('rx');
const ReactDOM = require("react-dom");


var keys = {
    goUp: event => (event.ctrlKey && event.keyCode === 80) || event.keyCode === 38,
    goDown: event => (event.ctrlKey && event.keyCode === 78) || event.keyCode === 40,
    enter: event => event.keyCode === 13,
    tab: event => event.keyCode === 9,
    deleteWord: event => event.ctrlKey && event.keyCode === 87,
    interrupt: event => event.ctrlKey && event.keyCode === 67
};


function setCaretPosition(node, position) {
    var selection = window.getSelection();
    var range = document.createRange();

    if (node.childNodes.length) {
        range.setStart(node.childNodes[0], position);
    } else {
        range.setStart(node, 0);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function getCaretPosition():number {
    return window.getSelection().anchorOffset;
}

function isCommandKey(event) {
    return _.contains([16, 17, 18], event.keyCode) || event.ctrlKey || event.altKey || event.metaKey;
}

export function isMetaKey(event) {
    return event.metaKey || _.some([event.key, event.keyIdentifier],
            key => _.includes(['Shift', 'Alt', 'Ctrl'], key));
}

function isShellHandledKey(event) {
    return keys.interrupt(event);
}

const isDefinedKey = _.memoize(event => _.some(_.values(keys), (matcher:(event:React.KeyboardEvent) => boolean) => matcher(event)),
    event => [event.ctrlKey, event.keyCode]);

// TODO: Figure out how it works.
function createEventHandler():any {
    var subject:any = function () {
        subject.onNext.apply(subject, arguments);
    };

    function getEnumerablePropertyNames(target) {
        var result = [];
        for (var key in target) {
            result.push(key);
        }
        return result;
    }

    getEnumerablePropertyNames(Rx.Subject.prototype)
        .forEach(function (property) {
            subject[property] = Rx.Subject.prototype[property];
        });
    Rx.Subject.call(subject);

    return subject;
}

interface Props {
    status: e.Status;
    invocation: Invocation;
    invocationView: InvocationView;
    prompt: PromptModel;
}

interface State {
    caretPosition?: number;
    caretOffset?: number;
    highlightedSuggestionIndex?: number;
    latestKeyCode?: number;
    suggestions?: Suggestion[]
}


// TODO: Make sure we only update the view when the model changes.
export default class Prompt extends React.Component<Props, State> {
    private handlers:{
        onKeyDown: Function;
    };

    constructor(props) {
        super(props);
        var keysDownStream = createEventHandler();
        var [inProgressKeys, promptKeys] = keysDownStream.partition(_ => this.props.status === e.Status.InProgress);

        inProgressKeys
            .filter(_.negate(isMetaKey))
            .filter(_.negate(isShellHandledKey))
            .map(stopBubblingUp)
            .forEach(event => this.props.invocation.write(event));

        var meaningfulKeysDownStream = promptKeys.filter(isDefinedKey).map(stopBubblingUp);
        var [navigateAutocompleteStream, navigateHistoryStream] = meaningfulKeysDownStream
            .filter(event => keys.goDown(event) || keys.goUp(event))
            .partition(() => this.autocompleteIsShown());

        keysDownStream.filter(_.negate(isCommandKey))
            .forEach(event => this.setState({latestKeyCode: event.keyCode}));

        promptKeys.filter(keys.enter).forEach(() => this.execute());

        meaningfulKeysDownStream.filter(() => this.autocompleteIsShown())
            .filter(keys.tab)
            .forEach(() => this.selectAutocomplete());

        meaningfulKeysDownStream.filter(keys.deleteWord).forEach(() => this.deleteWord());
        inProgressKeys.filter(keys.interrupt).forEach(() => this.props.invocation.interrupt());

        navigateHistoryStream.forEach(event => this.navigateHistory(event));
        navigateAutocompleteStream.forEach(event => this.navigateAutocomplete(event));

        this.state = {
            suggestions: [],
            highlightedSuggestionIndex: 0,
            latestKeyCode: null,
            caretPosition: 0,
            caretOffset: 0
        };


        this.handlers = {
            onKeyDown: keysDownStream
        };
    }

    componentDidMount() {

        $(ReactDOM.findDOMNode(this)).fixedsticky();
        $('.fixedsticky-dummy').remove();

        this.commandNode.focus();
    }

    private get commandNode():HTMLInputElement {
        return <any>this.refs['command'];
    }

    componentDidUpdate(prevProps, prevState) {
        if (this.props.status !== e.Status.NotStarted) {
            return;
        }

        this.commandNode.innerText = this.getText();

        if (this.state.caretPosition !== getCaretPosition() || prevState.caretOffset !== this.state.caretOffset) {
            setCaretPosition(this.commandNode, this.state.caretPosition);
        }

        if (prevState.caretPosition !== this.state.caretPosition) {
            this.setState({caretOffset: $(this.commandNode).caret('offset')});
        }

        scrollToBottom();

    }

    execute() {
        if (!this.isEmpty()) {
            // Timeout prevents two-line input on cd.
            setTimeout(() => this.props.prompt.execute(), 0);
        }
    }

    getText() {
        return this.props.prompt.buffer.toString();
    }

    replaceText(text) {
        this.setText(text, text.length);
    }

    setText(text, position = getCaretPosition()) {
        this.props.invocation.setPromptText(text);
        this.setState({caretPosition: position});
    }

    isEmpty() {
        return this.getText().replace(/\s/g, '').length === 0;
    }

    navigateHistory(event) {
        if (keys.goUp(event)) {
            this.replaceText(History.getPrevious());
        } else {
            this.replaceText(History.getNext());
        }
    }

    navigateAutocomplete(event) {
        if (keys.goUp(event)) {
            var index = Math.max(0, this.state.highlightedSuggestionIndex - 1)
        } else {
            index = Math.min(this.state.suggestions.length - 1, this.state.highlightedSuggestionIndex + 1)
        }

        this.setState({highlightedSuggestionIndex: index});
    }

    selectAutocomplete() {
        var state = this.state;
        const suggestion = state.suggestions[state.highlightedSuggestionIndex];

        if (suggestion.replaceAll) {
            this.replaceText(suggestion.value)
        } else {
            this.props.prompt.replaceCurrentLexeme(suggestion);
            if (!suggestion.partial) {
                this.props.prompt.buffer.write(' ');
            }

            this.setState({caretPosition: this.getText().length});
        }

        this.props.prompt.getSuggestions().then(suggestions =>
            this.setState({suggestions: suggestions, highlightedSuggestionIndex: 0})
        );
    }

    deleteWord() {
        // TODO: Remove the word under the caret instead of the last one.
        var newCommand = this.props.prompt.expanded.slice(0, -1).join(' ');

        if (newCommand.length) {
            newCommand += ' ';
        }

        this.replaceText(newCommand);
    }

    handleInput(event) {
        this.setText(event.target.innerText);

        //TODO: remove repetition.
        //TODO: make it a stream.
        this.props.prompt.getSuggestions().then(suggestions =>
            this.setState({suggestions: suggestions, highlightedSuggestionIndex: 0})
        );
    }

    handleScrollToTop(event) {
        stopBubblingUp(event);

        const offset = $(ReactDOM.findDOMNode(this.props.invocationView)).offset().top - 10;
        $('html, body').animate({scrollTop: offset}, 300);
    }

    handleKeyPress(event) {
        if (this.props.status === e.Status.InProgress) {
            stopBubblingUp(event);
        }
    }

    showAutocomplete() {
        //TODO: use streams.
        return this.commandNode &&
            this.state.suggestions.length &&
            this.props.status === e.Status.NotStarted && !_.contains([13, 27], this.state.latestKeyCode);
    }

    autocompleteIsShown():boolean {
        return !!this.refs['autocomplete'];
    }

    render() {
        var classes = ['prompt-wrapper', 'fixedsticky', this.props.status].join(' ');

        if (this.showAutocomplete()) {
            var autocomplete = React.createElement(Autocomplete, {
                suggestions: this.state.suggestions,
                caretOffset: this.state.caretOffset,
                highlightedIndex: this.state.highlightedSuggestionIndex,
                ref: 'autocomplete'
            });
        }

        if (this.props.invocationView.state.canBeDecorated) {
            var decorationToggle = React.createElement(DecorationToggle, {invocation: this.props.invocationView});
        }

        if (this.props.invocation.hasOutput()) {
            var scrollToTop = React.createElement(
                'a',
                {href: '#', className: 'scroll-to-top', onClick: this.handleScrollToTop.bind(this)},
                React.createElement('i', {className: 'fa fa-long-arrow-up'})
            );
        }

        return React.createElement(
            'div',
            {className: classes},
            React.createElement(
                'div',
                {className: 'prompt-decoration'},
                React.createElement('div', {className: 'arrow'})
            ),
            React.createElement('div', {className: 'prompt-info', title: this.props.status}),
            React.createElement('div', {
                className: 'prompt',
                onKeyDown: this.handlers.onKeyDown.bind(this),
                onInput: this.handleInput.bind(this),
                onKeyPress: this.handleKeyPress.bind(this),
                type: 'text',
                ref: 'command',
                contentEditable: 'true'
            }),
            autocomplete,
            React.createElement(
                'div',
                {className: 'actions'},
                decorationToggle,
                scrollToTop
            )
        );
    }
}
