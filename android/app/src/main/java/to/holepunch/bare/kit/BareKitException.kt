package to.holepunch.bare.kit

/** An error from Bare Kit. */
public sealed class BareKitException(message: String) : Exception(message) {
  /**
   * A call into Bare Kit failed.
   *
   * @property status The status the call failed with.
   */
  public class Failed(public val status: Int) :
    BareKitException("Bare Kit failed with status $status")

  /** The IPC was closed before the data could be written. */
  public class Closed : BareKitException("The IPC was closed")
}
