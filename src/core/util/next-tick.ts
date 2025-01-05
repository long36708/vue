/* globals MutationObserver */

import { noop } from 'shared/util'
import { handleError } from './error'
import { isIE, isIOS, isNative } from './env'

/**
 * eventLoop 事件循环知识点：
 * microTask是在同步方法完成的末尾去执行， macroTask则是直接是到下一个task了，
 * task之间又可能会包含浏览器的重渲染，
 * setTimeout默认的4ms延迟等等...
 * 从性能和时效性来看都是microTask更为优先
 */
export let isUsingMicroTask = false

// callbacks用来存放我们需要异步执行的函数队列，
const callbacks: Array<Function> = []
// pending用来标记是否已经命令callbacks在下个tick全部执行，防止多次调用。
let pending = false

function flushCallbacks() {
  pending = false
  const copies = callbacks.slice(0)
  callbacks.length = 0
  for (let i = 0; i < copies.length; i++) {
    copies[i]()
  }
}

/**
 * 这里我们有了使用微任务的异步延迟包装器。
 * 在 2.5 中，我们使用了（宏）任务（与微任务相结合）。
 * 但是，当 state 在 repaint 之前更改时，它存在细微的问题（例如 6813，out-in transitions）。
 * 此外，在事件处理程序中使用（宏）任务会导致一些无法规避的奇怪行为（例如 7109、7153、7546、7834、8109）。
 * 因此，我们现在再次在任何地方使用微任务。
 * 这种权衡的一个主要缺点是，在某些情况下，微任务的优先级太高，
 * 并在所谓的顺序事件之间（例如 4521、6690，有解决方法）甚至在同一事件的冒泡之间 （6566） 触发。
 */
// Here we have async deferring wrappers using microtasks.
// In 2.5 we used (macro) tasks (in combination with microtasks).
// However, it has subtle problems when state is changed right before repaint
// (e.g. #6813, out-in transitions).
// Also, using (macro) tasks in event handler would cause some weird behaviors
// that cannot be circumvented (e.g. #7109, #7153, #7546, #7834, #8109).
// So we now use microtasks everywhere, again.
// A major drawback of this tradeoff is that there are some scenarios
// where microtasks have too high a priority and fire in between supposedly
// sequential events (e.g. #4521, #6690, which have workarounds)
// or even between bubbling of the same event (#6566).
let timerFunc

/**
 * nextTick 行为利用了微任务队列，该队列可以通过原生 Promise.then 或 MutationObserver 访问。
 * MutationObserver 具有更广泛的支持，但是在触摸事件处理程序中触发时，
 * 它在 iOS >= 9.3.3 的 UIWebView 中受到严重错误。
 * 触发几次后完全停止工作......
 * 因此，如果原生 Promise 可用，我们将使用它：
 */
// The nextTick behavior leverages the microtask queue, which can be accessed
// via either native Promise.then or MutationObserver.
// MutationObserver has wider support, however it is seriously bugged in
// UIWebView in iOS >= 9.3.3 when triggered in touch event handlers. It
// completely stops working after triggering a few times... so, if native
// Promise is available, we will use it:
/* istanbul ignore next, $flow-disable-line */
if (typeof Promise !== 'undefined' && isNative(Promise)) {
  const p = Promise.resolve()
  timerFunc = () => {
    p.then(flushCallbacks)

    /**
     * 在有问题的 UIWebView 中，Promise.then 并没有完全崩溃，但它可能会陷入一种奇怪的状态，
     * 即回调被推送到微任务队列中，但队列没有被刷新，直到浏览器需要做一些其他工作，例如处理计时器。
     * 因此，我们可以通过添加空计时器来 “强制” 刷新微任务队列。
     */
    // In problematic UIWebViews, Promise.then doesn't completely break, but
    // it can get stuck in a weird state where callbacks are pushed into the
    // microtask queue but the queue isn't being flushed, until the browser
    // needs to do some other work, e.g. handle a timer. Therefore we can
    // "force" the microtask queue to be flushed by adding an empty timer.
    if (isIOS) setTimeout(noop)
  }
  isUsingMicroTask = true
} else if (
  !isIE &&
  typeof MutationObserver !== 'undefined' &&
  (isNative(MutationObserver) ||
    // PhantomJS and iOS 7.x
    MutationObserver.toString() === '[object MutationObserverConstructor]')
) {
  /**
   * 在原生 Promise 不可用的地方使用 MutationObserver，
   * 例如 PhantomJS、iOS7、Android 4.4
   * （6466 MutationObserver 在 IE11 中不可靠）
   */
  // Use MutationObserver where native Promise is not available,
  // e.g. PhantomJS, iOS7, Android 4.4
  // (#6466 MutationObserver is unreliable in IE11)
  let counter = 1
  const observer = new MutationObserver(flushCallbacks)
  const textNode = document.createTextNode(String(counter))
  observer.observe(textNode, {
    characterData: true
  })
  timerFunc = () => {
    counter = (counter + 1) % 2
    textNode.data = String(counter)
  }
  isUsingMicroTask = true
} else if (typeof setImmediate !== 'undefined' && isNative(setImmediate)) {
  /**
   * 回退到 setImmediate。
   * 从技术上讲，它利用了（宏）任务队列，
   * 但它仍然是比 setTimeout 更好的选择。
   */
  // Fallback to setImmediate.
  // Technically it leverages the (macro) task queue,
  // but it is still a better choice than setTimeout.
  timerFunc = () => {
    setImmediate(flushCallbacks)
  }
} else {
  /**
   * 回退到 setTimeout
   */
  // Fallback to setTimeout.
  timerFunc = () => {
    setTimeout(flushCallbacks, 0)
  }
}

export function nextTick(): Promise<void>
export function nextTick<T>(this: T, cb: (this: T, ...args: any[]) => any): void
export function nextTick<T>(cb: (this: T, ...args: any[]) => any, ctx: T): void
/**
 * @internal
 */
export function nextTick(cb?: (...args: any[]) => any, ctx?: object) {
  let _resolve
  callbacks.push(() => {
    if (cb) {
      try {
        cb.call(ctx)
      } catch (e: any) {
        handleError(e, ctx, 'nextTick')
      }
    } else if (_resolve) {
      _resolve(ctx)
    }
  })
  if (!pending) {
    pending = true
    timerFunc()
  }
  // $flow-disable-line
  if (!cb && typeof Promise !== 'undefined') {
    return new Promise(resolve => {
      _resolve = resolve
    })
  }
}
